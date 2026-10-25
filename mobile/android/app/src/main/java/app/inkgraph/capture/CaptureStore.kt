package app.inkgraph.capture

import android.content.Context
import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.provider.MediaStore
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
    val deviceId: String get() { val current=prefs.getString("deviceId",null);if(current!=null)return current;val id=UUID.randomUUID().toString();check(prefs.edit().putString("deviceId",id).commit());return id }
    @Synchronized fun read(id: String): JSONObject? = readableDatabase.rawQuery("SELECT data FROM captures WHERE id=?",arrayOf(id)).use { if(it.moveToFirst())JSONObject(it.getString(0)) else null }
    @Synchronized fun all(): List<JSONObject> = readableDatabase.rawQuery("SELECT data FROM captures ORDER BY rowid DESC",null).use { c -> val rows=mutableListOf<JSONObject>();while(c.moveToNext())rows.add(JSONObject(c.getString(0)));rows }
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
