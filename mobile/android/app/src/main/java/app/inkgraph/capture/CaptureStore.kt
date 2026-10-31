package app.inkgraph.capture

import android.content.Context
import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.provider.MediaStore
import android.content.ContentUris
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class CaptureStore private constructor(private val ctx: Context): SQLiteOpenHelper(ctx, "captures.sqlite", null, 1) {
    companion object {
        @Volatile private var instance: CaptureStore? = null
        fun get(ctx: Context): CaptureStore = instance ?: synchronized(this) { instance ?: CaptureStore(ctx.applicationContext).also { instance=it } }
        fun now() = Instant.now().toString()
        fun sha(file: File): String { val md=MessageDigest.getInstance("SHA-256");file.inputStream().use { input -> val buf=ByteArray(65536);while(true){val n=input.read(buf);if(n<0)break;md.update(buf,0,n)} };return md.digest().joinToString(""){"%02x".format(it)} }
        fun sha(bytes: ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
    }
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE captures(id TEXT PRIMARY KEY,data TEXT NOT NULL)") }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, next: Int) { error("Unsupported capture database version") }
    val prefs=ctx.getSharedPreferences("capture", Context.MODE_PRIVATE)
    data class Presentation(val title:String,val phase:String,val state:String,val details:String)
    fun presentation(row:JSONObject):Presentation {
        val media=row.getJSONArray("media");var photos=0;var seconds=0L
        for(i in 0 until media.length()){val item=media.getJSONObject(i);if(item.optString("type")=="audio")seconds+=item.optLong("durationMs")/1000 else photos++}
        val title=row.optString("text").lineSequence().firstOrNull{it.isNotBlank()}?.trim()?.take(60)
            ?:when{photos>0&&seconds>0->"照片與語音記錄";photos>0->"照片記錄";seconds>0->"語音記錄";else->"未命名草稿"}
        val completed=row.optBoolean("completed")
        val received=completed&&prefs.contains("received:${row.getString("id")}:${row.getInt("revision")}")
        val phase=when{row.optBoolean("recording")->"recording";!completed->"draft";received->"received";else->"pending"}
        val state=when(phase){"recording"->"正在錄音";"received"->"此版本已接收";"pending"->"可傳至電腦";else->if(row.optInt("revision",1)>1)"草稿 · 有新版待完成" else "草稿 · 已保存"}
        return Presentation(title,phase,state,"照片 $photos 張 · 錄音 ${seconds/60}分${seconds%60}秒")
    }
    val deviceId: String get() { val current=prefs.getString("deviceId",null);if(current!=null)return current;val id=UUID.randomUUID().toString();check(prefs.edit().putString("deviceId",id).commit());return id }
    @Synchronized fun read(id: String): JSONObject? = readableDatabase.rawQuery("SELECT data FROM captures WHERE id=?",arrayOf(id)).use { if(it.moveToFirst())JSONObject(it.getString(0)) else null }
    @Synchronized fun all(): List<JSONObject> = readableDatabase.rawQuery("SELECT data FROM captures ORDER BY rowid DESC",null).use { c -> val rows=mutableListOf<JSONObject>();while(c.moveToNext())rows.add(JSONObject(c.getString(0)));rows }
    @Synchronized fun updateLocationIfPresent(id:String,change:(JSONObject)->Unit){if(read(id)!=null)mutate(id){change(it.getJSONObject("location"))}}
    @Synchronized fun mutate(id: String, change: (JSONObject)->Unit): JSONObject {
        val db=writableDatabase;db.beginTransaction();try{val row=read(id)?:error("找不到草稿");change(row);row.put("updatedAt",now());db.insertWithOnConflict("captures",null,ContentValues().apply{put("id",id);put("data",row.toString())},SQLiteDatabase.CONFLICT_REPLACE);db.setTransactionSuccessful();return row}finally{db.endTransaction()}
    }
    @Synchronized fun create(): JSONObject {
        val zone=ZoneId.systemDefault();val instant=Instant.now();val id=UUID.randomUUID().toString()
        val row=JSONObject().put("id",id).put("revision",1).put("createdAt",instant.toString()).put("updatedAt",instant.toString()).put("timezone",zone.id).put("utcOffsetMinutes",zone.rules.getOffset(instant).totalSeconds/60).put("text","").put("location",JSONObject().put("status","unknown")).put("media",JSONArray()).put("completed",false)
        writableDatabase.insertOrThrow("captures",null,ContentValues().apply{put("id",id);put("data",row.toString())});return row
    }
    fun mediaDir(id: String): File { require(id.matches(Regex("[a-f0-9-]{36}")));return File(ctx.filesDir,"captures/$id/media").apply{mkdirs()} }
    fun addMedia(id: String, media: JSONObject) { mutate(id){it.getJSONArray("media").put(media);it.remove("inflight")} }
    fun mediaMeta(id: String, file: File, type: String, mime: String, at: String=now()): JSONObject = JSONObject().put("id",id).put("file","media/${file.name}").put("name",file.name).put("type",type).put("mime",mime).put("size",file.length()).put("sha256",sha(file)).put("capturedAt",at)
    @Synchronized fun deleteCapture(id:String) {
        require(UUID.fromString(id).toString()==id){"記錄識別碼不正確"}
        val row=read(id)?:error("找不到記錄")
        check(!row.optBoolean("recording")&&!RecordingService.inProcessRecording){"請先停止錄音，等片段保存完成"}
        val captures=File(ctx.filesDir,"captures").canonicalFile
        val record=File(captures,id).canonicalFile
        check(record.parentFile==captures){"附件路徑不正確"}
        val resolver=ctx.contentResolver
        val path="Download/InkGraph-Capture/$deviceId"
        val names=Regex("^${Regex.escape(id)}-r[1-9][0-9]*(?: \\([0-9]+\\))?\\.igc$")
        val packages=mutableListOf<android.net.Uri>()
        resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,arrayOf(MediaStore.Downloads._ID,MediaStore.Downloads.DISPLAY_NAME,MediaStore.MediaColumns.OWNER_PACKAGE_NAME),"${MediaStore.Downloads.RELATIVE_PATH}=? OR ${MediaStore.Downloads.RELATIVE_PATH}=?",arrayOf(path,"$path/"),null)?.use{cursor->
            while(cursor.moveToNext())if(cursor.getString(2)==ctx.packageName&&names.matches(cursor.getString(1)))packages.add(ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI,cursor.getLong(0)))
        }?:error("無法檢查手機傳輸包，尚未刪除記錄")
        // Remove outbox packages first so a deleted capture cannot be imported later.
        for(uri in packages)check(resolver.delete(uri,null,null)>0){"無法刪除傳輸包，記錄仍保留，請重試"}
        check(!record.exists()||record.deleteRecursively()){"部分附件無法刪除，請重試"}
        val frozenNames=Regex("^${Regex.escape(id)}-r[1-9][0-9]*\\.json(?:\\.partial)?$")
        for(file in File(ctx.filesDir,"exports").listFiles().orEmpty())if(frozenNames.matches(file.name))check(file.delete()){"無法刪除匯出索引，請重試"}
        for(file in ctx.cacheDir.listFiles().orEmpty())if(file.name.endsWith(".partial")&&names.matches(file.name.removeSuffix(".partial")))check(file.delete()){"無法刪除傳輸暫存，請重試"}
        check(writableDatabase.delete("captures","id=?",arrayOf(id))==1){"記錄刪除失敗"}
        val edit=prefs.edit()
        for(key in prefs.all.keys)if(key.startsWith("export:$id:")||key.startsWith("received:$id:"))edit.remove(key)
        edit.apply()
    }
    fun export(id: String): Pair<String,String> {
        val row=read(id)?:error("找不到記錄");check(!row.optBoolean("recording")){"請先停止錄音"};check(row.optString("text").isNotBlank()||row.getJSONArray("media").length()>0){"請輸入文字、錄音或照片"}
        val capture=JSONObject(row.toString());capture.remove("recording");capture.remove("inflight");capture.remove("completed");capture.put("completedAt",now())
        val frozen=File(ctx.filesDir,"exports/${row.getString("id")}-r${row.getInt("revision")}.json");frozen.parentFile!!.mkdirs()
        val manifest=if(frozen.exists())frozen.readBytes()else JSONObject().put("format","inkgraph-capture").put("version",1).put("deviceId",deviceId).put("capture",capture).toString().toByteArray(Charsets.UTF_8).also{bytes->val partial=File(frozen.path+".partial");partial.outputStream().use{out->out.write(bytes);out.fd.sync()};check(partial.renameTo(frozen))}
        val frozenCapture=JSONObject(String(manifest,Charsets.UTF_8)).getJSONObject("capture")
        val name="${row.getString("id")}-r${row.getInt("revision")}.igc";val tmp=File(ctx.cacheDir,"$name.partial")
        try {
            ZipOutputStream(tmp.outputStream()).use { zip -> zip.putNextEntry(ZipEntry("manifest.json"));zip.write(manifest);zip.closeEntry();val media=frozenCapture.getJSONArray("media");for(i in 0 until media.length()){val m=media.getJSONObject(i);val file=File(mediaDir(id),m.getString("file").substringAfterLast('/'));check(sha(file)==m.getString("sha256")){"原始附件已變更"};zip.putNextEntry(ZipEntry(m.getString("file")));file.inputStream().use{it.copyTo(zip)};zip.closeEntry()} }
            val values=ContentValues().apply{put(MediaStore.Downloads.DISPLAY_NAME,name);put(MediaStore.Downloads.MIME_TYPE,"application/vnd.inkgraph.capture+zip");put(MediaStore.Downloads.RELATIVE_PATH,"Download/InkGraph-Capture/$deviceId");put(MediaStore.Downloads.IS_PENDING,1)}
            val resolver=ctx.contentResolver;val uri=resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,values)?:error("無法建立傳輸包")
            try { resolver.openOutputStream(uri,"w")!!.use{out->tmp.inputStream().use{it.copyTo(out)}};resolver.update(uri,ContentValues().apply{put(MediaStore.Downloads.IS_PENDING,0)},null,null) }catch(e:Exception){resolver.delete(uri,null,null);throw e}
            val digest=sha(manifest);check(prefs.edit().putString("export:$id:${row.getInt("revision")}",digest).commit());mutate(id){it.put("completed",true);it.put("completedAt",capture.getString("completedAt"))};return Pair(name,digest)
        } finally { tmp.delete() }
    }
}
