"""Local-only CPU recognizer. Preparation is explicit; jobs never download ASR models."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import threading
import time
import hashlib

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def ocr_engine(models):
    from rapidocr import RapidOCR
    return RapidOCR(params={"Global.model_root_dir": str(models / "ocr"),
                            "Global.log_level": "warning",
                            "EngineConfig.onnxruntime.intra_op_num_threads": 4,
                            "EngineConfig.onnxruntime.inter_op_num_threads": 1})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--model", choices=["base", "small"], default="base")
    parser.add_argument("--kind", choices=["ocr", "asr"])
    parser.add_argument("--input")
    parser.add_argument("--output")
    args = parser.parse_args()
    models = Path(args.models).resolve()
    models.mkdir(parents=True, exist_ok=True)
    if args.prepare:
        from huggingface_hub import snapshot_download
        snapshot_download("Systran/faster-whisper-" + args.model,
                          local_dir=models / ("asr-" + args.model),
                          allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "preprocessor_config.json"])
        engine = ocr_engine(models)
        # RapidOCR 3.10 loads lazily; prepare every model before accepting jobs.
        engine._load_det_model()
        engine._load_cls_model()
        engine._load_rec_model()
        records = {}
        for file in models.rglob("*"):
            if file.is_file() and (file.suffix == ".onnx" or file.name in {"model.bin", "config.json", "tokenizer.json"}) and ".cache" not in file.parts:
                digest = hashlib.sha256()
                with file.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(block)
                records[file.relative_to(models).as_posix()] = {"sha256": digest.hexdigest(), "bytes": file.stat().st_size}
        (models / "model-manifest.json").write_text(json.dumps({"files": records,
            "packages": {name: importlib.metadata.version(name) for name in ["rapidocr", "onnxruntime", "faster-whisper", "ctranslate2"]}}, indent=2), encoding="utf-8")
        print(json.dumps({"ready": True, "model": args.model, "models": str(models)}))
        return
    if not args.input or not args.output or not args.kind:
        parser.error("job requires --input, --output and --kind")
    # Jobs are offline, including lazy OCR dependencies. Download only in prepare.
    import socket
    def offline_only(*unused, **kwargs):
        raise RuntimeError("辨識工作禁止網路連線；請先另行完成模型準備")
    socket.socket.connect = offline_only
    socket.socket.connect_ex = offline_only
    socket.getaddrinfo = offline_only
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    import psutil
    proc = psutil.Process()
    peak = [proc.memory_info().rss]
    done = threading.Event()
    started = time.perf_counter()
    output = Path(args.output)

    def sample():
        while not done.wait(.1):
            peak[0] = max(peak[0], proc.memory_info().rss)
            if peak[0] > 3 * 1024 ** 3:
                output.write_text(json.dumps({"error": "辨識程序超過3GiB預算，已停止；原檔保留"}), encoding="utf-8")
                os._exit(75)
    threading.Thread(target=sample, daemon=True).start()
    try:
        if args.kind == "ocr":
            # No silent model downloading from a background job.
            if not (models / "ocr").exists() or len(list((models / "ocr").rglob("*.onnx"))) < 3:
                raise RuntimeError("OCR模型未備妥，請先執行本地模型準備")
            from PIL import Image, ImageOps
            Image.MAX_IMAGE_PIXELS = 20_000_000
            with Image.open(args.input) as original:
                if original.width * original.height > 20_000_000:
                    raise ValueError("照片超過2000萬像素，請另製縮圖進行辨識")
                image = ImageOps.exif_transpose(original).convert("RGB")
                oriented_size = list(image.size)
                image.thumbnail((2400, 2400))
                derivative = output.with_suffix(".normalized.png")
                image.save(derivative)
            result = ocr_engine(models)(str(derivative))
            lines = [{"text": str(text), "score": float(score), "box": box.tolist()}
                     for text, score, box in zip(result.txts or [], result.scores or [], result.boxes if result.boxes is not None else [])]
            data = {"text": "\n".join(line["text"] for line in lines), "lines": lines,
                    "coordinateSpace": "exif-oriented-thumbnail", "orientedSize": oriented_size,
                    "processedSize": list(image.size), "engine": "rapidocr", "version": importlib.metadata.version("rapidocr")}
        else:
            from faster_whisper import WhisperModel
            directory = models / ("asr-" + args.model)
            if not (directory / "model.bin").exists():
                raise RuntimeError("語音模型未備妥，請先執行本地模型準備")
            engine = WhisperModel(str(directory), device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, local_files_only=True)
            # Our app records PCM WAV. Read it directly to avoid PyAV API changes,
            # preserve samples, and validate the actual sampling format.
            import wave
            import numpy as np
            with wave.open(args.input, "rb") as audio:
                if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
                    raise ValueError("第一版語音需為單聲道16bit PCM WAV")
                rate = audio.getframerate()
                if rate < 8000 or rate > 48000 or audio.getnframes() / rate > 600:
                    raise ValueError("錄音採樣率或單段長度超出範圍")
                samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
            if rate != 16000:
                samples = np.interp(np.arange(int(len(samples) * 16000 / rate)) * rate / 16000,
                                    np.arange(len(samples)), samples).astype(np.float32)
            segments, info = engine.transcribe(samples, beam_size=5, vad_filter=True,
                                               condition_on_previous_text=False)
            rows = [{"start": float(s.start), "end": float(s.end), "text": s.text,
                     "noSpeechProbability": float(s.no_speech_prob)} for s in segments]
            data = {"text": "\n".join(s["text"] for s in rows), "segments": rows,
                    "language": info.language, "duration": float(info.duration), "model": args.model,
                    "engine": "faster-whisper", "computeType": "int8", "version": importlib.metadata.version("faster-whisper")}
        data.update({"kind": args.kind, "verified": False, "elapsedSeconds": round(time.perf_counter() - started, 3),
                     "peakRssBytes": max(peak[0], proc.memory_info().rss), "cpuThreads": 4})
        provenance = models / "model-manifest.json"
        if provenance.exists():
            data["modelManifestSha256"] = hashlib.sha256(provenance.read_bytes()).hexdigest()
            registered = json.loads(provenance.read_text(encoding="utf-8"))["files"]
            data["modelFiles"] = {name: record for name, record in registered.items()
                                  if name.startswith("ocr/" if args.kind == "ocr" else "asr-" + args.model + "/")}
        output.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    except Exception as error:
        output.write_text(json.dumps({"error": str(error)}, ensure_ascii=False), encoding="utf-8")
        raise
    finally:
        done.set()


if __name__ == "__main__":
    main()
