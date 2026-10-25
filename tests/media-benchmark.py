"""Generate synthetic OCR cases and derive audio durations for timing, never publish private samples."""
import argparse
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import wave
import hashlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter

parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
parser.add_argument("--models", required=True)
parser.add_argument("--worker", required=True)
parser.add_argument("--vault")
parser.add_argument("--model", default="base", choices=["base", "small"])
parser.add_argument("--audio", action="store_true")
parser.add_argument("--durations", nargs="+", type=int, default=[60,600])
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
results = []
if not args.audio:
    font = ImageFont.truetype("C:/Windows/Fonts/msjh.ttc", 62)
    image = Image.new("RGB", (1800, 900), "white")
    ImageDraw.Draw(image).multiline_text((90, 100), "墨脈研究筆記\n記錄時間與地點\n原始資料保留，不自動覆蓋。\nResearch notes and sources.", fill="black", font=font, spacing=45)
    cases = {"clear": image, "rotated180": image.rotate(180), "blank": Image.new("RGB", image.size, "white"),
             "blurred": image.filter(ImageFilter.GaussianBlur(3)), "rotated90": image.rotate(90, expand=True)}
    for name, pic in cases.items():
        file = out / (name + ".png")
        pic.save(file)
        before = hashlib.sha256(file.read_bytes()).hexdigest()
        target = out / (name + ".json")
        run = subprocess.run([sys.executable, args.worker, "--models", args.models, "--kind", "ocr", "--input", str(file), "--output", str(target)], capture_output=True)
        data = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {"error": "no result"}
        result = {"case": name, "exitCode": run.returncode, "characters": len(data.get("text", "")),
                  "seconds": data.get("elapsedSeconds"), "peakMiB": round(data.get("peakRssBytes", 0) / 1024 ** 2),
                  "originalUnchanged": before == hashlib.sha256(file.read_bytes()).hexdigest(),
                  "expectedKeyword": "研究" in data.get("text", ""), "error": data.get("error")}
        if name == "blank":
            result["noInventedText"] = data.get("text", "") == ""
        results.append(result)
else:
    if not args.vault:
        parser.error("audio timing requires --vault")
    db = sqlite3.connect(str(Path(args.vault) / "inkgraph.sqlite"))
    row = db.execute("SELECT path FROM external_attachments WHERE mime='audio/wav' ORDER BY size DESC LIMIT 1").fetchone()
    if row is None:
        raise RuntimeError("No user-authorized audio test recording")
    original = Path(args.vault) / "originals" / row[0]
    with wave.open(str(original), "rb") as audio:
        rate = audio.getframerate()
        params = (audio.getnchannels(), audio.getsampwidth(), rate)
        samples = audio.readframes(audio.getnframes())
    for seconds in args.durations:
        if seconds < 1 or seconds > 600:
            raise ValueError("Benchmark duration must be between 1 and 600 seconds")
        file = out / ("timing-repeated-sample-" + str(seconds) + ".wav")
        needed = seconds * rate * params[0] * params[1]
        data = (samples * (needed // len(samples) + 1))[:needed]
        with wave.open(str(file), "wb") as audio:
            audio.setnchannels(params[0]); audio.setsampwidth(params[1]); audio.setframerate(rate); audio.writeframes(data)
        target = out / (str(seconds) + "-" + args.model + ".json")
        run = subprocess.run([sys.executable, args.worker, "--models", args.models, "--kind", "asr", "--model", args.model, "--input", str(file), "--output", str(target)], capture_output=True)
        result = json.loads(target.read_text(encoding="utf-8"))
        results.append({"case": "timing-only-repeated-authorized-sample", "model": args.model, "audioSeconds": seconds,
                        "exitCode": run.returncode, "seconds": result.get("elapsedSeconds"),
                        "peakMiB": round(result.get("peakRssBytes", 0) / 1024 ** 2), "error": result.get("error")})
    db.close()
file = out / ("summary-" + args.model + ("-audio" if args.audio else "-ocr") + ".json")
file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(results, ensure_ascii=False))
