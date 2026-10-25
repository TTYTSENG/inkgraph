package app.inkgraph.capture
import android.app.*
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.IBinder
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

class RecordingService: Service() {
    @Volatile private var active=false
    private var thread:Thread?=null
    override fun onBind(i:Intent?):IBinder?=null
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
        if(intent?.action=="stop"){active=false;return START_NOT_STICKY}
        if(active)return START_NOT_STICKY
        val id=intent?.getStringExtra("captureId")?:return START_NOT_STICKY
        val manager=getSystemService(NotificationManager::class.java);manager.createNotificationChannel(NotificationChannel("recording","錄音狀態",NotificationManager.IMPORTANCE_LOW))
        val stop=PendingIntent.getService(this,0,Intent(this,RecordingService::class.java).setAction("stop"),PendingIntent.FLAG_IMMUTABLE)
        startForeground(1,Notification.Builder(this,"recording").setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("墨脈正在錄音").setContentText("原始錄音保存在手機，點停止後可加入筆記").setOngoing(true).addAction(Notification.Action.Builder(null,"停止",stop).build()).build())
        active=true;inProcessRecording=true;thread=Thread{record(id)}.also{it.start()};return START_NOT_STICKY
    }
    private fun record(captureId:String){
        val store=CaptureStore.get(this);var recorder:AudioRecord?=null;var file:File?=null;var raf:RandomAccessFile?=null;var mediaId="";var at="";var bytes=0L;var offset=0L
        val previous=store.read(captureId)?.getJSONArray("media");if(previous!=null)for(i in 0 until previous.length()){val m=previous.getJSONObject(i);if(m.optString("type")=="audio")offset+=m.optLong("durationMs")}
        fun finish(){val f=file;val out=raf;if(f!=null&&out!=null){out.seek(0);writeHeader(out,bytes);out.fd.sync();out.close();if(bytes>0){val final=File(f.parentFile,"$mediaId.wav");check(f.renameTo(final));val meta=store.mediaMeta(mediaId,final,"audio","audio/wav",at).put("durationMs",bytes*1000/32000).put("offsetMs",offset).put("sampleRate",16000);store.read(captureId)?.optJSONObject("location")?.let{meta.put("location",JSONObject(it.toString()))};store.addMedia(captureId,meta);offset+=bytes*1000/32000}else{f.delete();store.mutate(captureId){it.remove("inflight")}}};file=null;raf=null;bytes=0}
        try{
            val size=AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);check(size>0){"此手機不支援16kHz錄音"}
            recorder=AudioRecord(MediaRecorder.AudioSource.MIC,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,maxOf(size*4,8192));check(recorder.state==AudioRecord.STATE_INITIALIZED){"麥克風尚未準備好"}
            store.mutate(captureId){it.put("recording",true)};recorder.startRecording();val buffer=ByteArray(maxOf(size,4096))
            while(active){
                if(raf==null){mediaId=UUID.randomUUID().toString();at=CaptureStore.now();file=File(store.mediaDir(captureId),"$mediaId.partial");store.mutate(captureId){it.put("inflight",JSONObject().put("id",mediaId).put("capturedAt",at).put("offsetMs",offset))};raf=RandomAccessFile(file,"rw");writeHeader(raf!!,0)}
                val n=recorder.read(buffer,0,buffer.size);check(n>0){"錄音中斷（$n）"};raf!!.write(buffer,0,n);bytes+=n
                if(bytes>=16000*2*60){finish();notifyChanged()}
            }
        }catch(e:Exception){store.mutate(captureId){it.put("recordingError",e.message?:"錄音中斷")}}
        finally{try{recorder?.stop()}catch(_:Exception){};recorder?.release();try{finish()}catch(e:Exception){store.mutate(captureId){it.put("recordingError","片段需於重開App後回復")}};active=false;inProcessRecording=false;store.mutate(captureId){it.put("recording",false)};notifyChanged();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf()}
    }
    private fun notifyChanged(){sendBroadcast(Intent("app.inkgraph.capture.CHANGED").setPackage(packageName))}
    override fun onDestroy(){active=false;super.onDestroy()}
    companion object {
        @Volatile var inProcessRecording=false
        fun writeHeader(out:RandomAccessFile,size:Long){fun le(n:Long,len:Int){for(i in 0 until len)out.write(((n shr(i*8))and 255).toInt())};out.writeBytes("RIFF");le(size+36,4);out.writeBytes("WAVEfmt ");le(16,4);le(1,2);le(1,2);le(16000,4);le(32000,4);le(2,2);le(16,2);out.writeBytes("data");le(size,4)}
        fun recover(store:CaptureStore){for(row in store.all()){val pending=row.optJSONObject("inflight");if(pending!=null){val id=row.getString("id");val mid=pending.getString("id");val f=File(store.mediaDir(id),"$mid.partial");if(f.exists()&&f.length()>44){val size=(f.length()-44)/2*2;RandomAccessFile(f,"rw").use{it.setLength(size+44);it.seek(0);writeHeader(it,size);it.fd.sync()};val final=File(f.parentFile,"$mid.wav");if(f.renameTo(final))store.addMedia(id,store.mediaMeta(mid,final,"audio","audio/wav",pending.getString("capturedAt")).put("durationMs",size*1000/32000).put("offsetMs",pending.optLong("offsetMs")).put("recovered",true))};store.mutate(id){it.put("recording",false);it.remove("inflight");it.put("recordingError","上次錄音中斷，已保留可回復片段")}}}}
    }
}
