package app.inkgraph.capture

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.graphics.Color
import android.location.*
import android.net.Uri
import android.os.*
import android.provider.MediaStore
import android.text.Editable
import android.text.TextWatcher
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.*
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import android.util.Base64

class MainActivity: Activity() {
    private lateinit var store:CaptureStore
    private var currentId:String?=null
    private var editor:EditText?=null
    private var place:EditText?=null
    private var locationText:TextView?=null
    private var recordingButton:Button?=null
    private var status:TextView?=null
    private var attachments:LinearLayout?=null
    private var player:android.media.MediaPlayer?=null
    private var cameraId:String?=null
    private var busy=false
    private val main=Handler(Looper.getMainLooper())
    private val autosave=Runnable{saveText()}
    private val changed=object:BroadcastReceiver(){override fun onReceive(c:Context?,i:Intent?){updateStatus()}}
    override fun onCreate(state:Bundle?){super.onCreate(state);store=CaptureStore.get(this);if(!RecordingService.inProcessRecording)RecordingService.recover(store);cameraId=state?.getString("cameraId");registerReceiver(changed,IntentFilter("app.inkgraph.capture.CHANGED"),Context.RECEIVER_NOT_EXPORTED);val id=state?.getString("captureId");if(id!=null&&store.read(id)!=null)compose(id)else home();receipt(intent)}
    override fun onNewIntent(value:Intent){super.onNewIntent(value);setIntent(value);receipt(value)}
    override fun onSaveInstanceState(out:Bundle){saveText();out.putString("captureId",currentId);out.putString("cameraId",cameraId);super.onSaveInstanceState(out)}
    override fun onPause(){saveText();super.onPause()}
    override fun onDestroy(){main.removeCallbacks(autosave);player?.release();unregisterReceiver(changed);super.onDestroy()}
    override fun onCreateOptionsMenu(menu:Menu):Boolean {menu.add(0,1,0,"草稿與傳輸狀態");return true}
    override fun onOptionsItemSelected(item:MenuItem):Boolean{if(item.itemId==1){saveText();list();return true};return super.onOptionsItemSelected(item)}
    private fun panel():LinearLayout {val root=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(24,20,24,24);setBackgroundColor(Color.rgb(246,245,238));fitsSystemWindows=true};val scroll=ScrollView(this);scroll.addView(root);setContentView(scroll);return root}
    private fun label(parent:LinearLayout,value:String,size:Float=17f):TextView=TextView(this).apply{text=value;textSize=size;setTextColor(Color.rgb(23,62,53));setPadding(0,12,0,16);parent.addView(this)}
    private fun button(parent:LinearLayout,title:String,action:()->Unit):Button=Button(this).apply{text=title;isAllCaps=false;minHeight=64;setOnClickListener{if(!busy)action()};parent.addView(this,LinearLayout.LayoutParams(-1,-2).apply{topMargin=12})}
    private fun received(row:JSONObject)=store.prefs.contains("received:${row.getString("id")}:${row.getInt("revision")}")
    private fun home(){currentId=null;editor=null;place=null;attachments=null;val p=panel();label(p,"墨脈隨手記",30f);label(p,"先留下想法，回到電腦再整理。\n文字、錄音與照片都保存在手機。",17f);button(p,"＋ 新增筆記"){val active=store.all().find{it.optBoolean("recording")};if(active!=null){compose(active.getString("id"));return@button};val row=store.create();compose(row.getString("id"));locate()};val rows=store.all();button(p,"草稿 ${rows.count{!it.optBoolean("completed")}} 則 · 繼續編輯"){list("draft")};button(p,"待傳至電腦／待回執 ${rows.count{it.optBoolean("completed")&&!received(it)}} 則"){list("pending")};button(p,"電腦已接收 ${rows.count{it.optBoolean("completed")&&received(it)}} 則"){list("received")};button(p,"查看全部記錄與傳輸狀態"){list()};label(p,"完成筆記後，接上USB，在電腦墨脈選「手機收件與辨識」。\n「已接收」需驗證電腦回執；辨識進度在電腦查看。\n手機原始記錄仍保留。",15f)}
    private fun list(filter:String="all"){val rows=store.all().filter{when(filter){"draft"->!it.optBoolean("completed");"pending"->it.optBoolean("completed")&&!received(it);"received"->it.optBoolean("completed")&&received(it);else->true}};if(rows.isEmpty()){error("此分類目前沒有記錄");return};AlertDialog.Builder(this).setTitle("草稿與傳輸狀態").setItems(rows.map{r->"${if(received(r))"電腦已接收" else if(r.optBoolean("completed"))"待傳輸／待回執" else "草稿"} · ${r.optString("text").take(24).ifBlank{r.getString("createdAt")}}"}.toTypedArray()){_,i->val row=rows[i];val active=store.all().find{it.optBoolean("recording")};if(active!=null&&active.getString("id")!=row.getString("id")){error("另一則草稿仍在錄音，請先回到錄音記錄");return@setItems};if(row.optBoolean("completed"))review(row.getString("id"))else compose(row.getString("id"))}.setNegativeButton("關閉",null).show()}
    private fun review(id:String){val row=store.read(id)?:return;currentId=null;editor=null;place=null;val p=panel();label(p,"記錄與傳輸狀態",27f);label(p,if(received(row))"電腦已接收原始檔（辨識進度請看電腦）" else "傳輸包已準備；等待電腦匯入或確認接收回執");label(p,"記錄：${row.getString("createdAt")}\n時區：${row.getString("timezone")}\n版本：${row.getInt("revision")}\n原始附件：${row.getJSONArray("media").length()} 個",14f);label(p,row.optString("text").ifBlank{"此則是語音／照片記錄"});attachments=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;p.addView(this)};showAttachments(row,false);button(p,"續寫成下一版（保留已傳版本）"){store.mutate(id){it.put("revision",it.getInt("revision")+1);it.put("completed",false);it.remove("completedAt")};compose(id)};button(p,"返回首頁"){home()}}
    private fun compose(id:String){
        currentId=id;val row=store.read(id)?:return;val p=panel();label(p,"新增筆記",27f);button(p,"草稿與傳輸狀態"){saveText();list()};val time=try{DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm:ss").withZone(ZoneId.of(row.getString("timezone"))).format(Instant.parse(row.getString("createdAt")))}catch(_:Exception){row.getString("createdAt")};label(p,"記錄時間：$time\n時區：${row.getString("timezone")}",14f)
        locationText=label(p,"",15f).apply{setOnClickListener{locate()}}
        place=EditText(this).apply{hint="地點名稱（選填，例如圖書館）";setSingleLine();setText(row.optJSONObject("location")?.optString("label")?:"");p.addView(this)}
        editor=EditText(this).apply{hint="寫下此刻的想法…";minLines=6;gravity=android.view.Gravity.TOP;textSize=18f;setText(row.optString("text"));p.addView(this)}
        val watcher=object:TextWatcher{override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){};override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){main.removeCallbacks(autosave);main.postDelayed(autosave,600)};override fun afterTextChanged(s:Editable?){} };editor!!.addTextChangedListener(watcher);place!!.addTextChangedListener(watcher)
        recordingButton=button(p,"開始錄音"){saveText();if(store.read(id)?.optBoolean("recording")==true)startService(Intent(this,RecordingService::class.java).setAction("stop"))else microphone()}
        button(p,"拍攝照片"){saveText();cameraId=UUID.randomUUID().toString();val uri=Uri.parse("content://$packageName.files/$id/$cameraId.jpg");val camera=Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION);try{startActivityForResult(camera,301)}catch(e:Exception){error("無法開啟相機：${e.message}")}}
        button(p,"選取一張照片"){saveText();startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE),302)}
        attachments=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;p.addView(this)}
        status=label(p,"",15f);button(p,"完成並準備 USB 傳輸"){saveText();if(store.read(id)?.optBoolean("recording")==true){error("請先停止錄音，等原始片段保存完成");return@button};busy=true;editor?.isEnabled=false;place?.isEnabled=false;status?.text="正在校驗並準備傳輸包…";Thread{try{store.export(id);runOnUiThread{busy=false;Toast.makeText(this,"已保存，接上 USB 後可由墨脈匯入",Toast.LENGTH_LONG).show();home()}}catch(e:Exception){runOnUiThread{busy=false;editor?.isEnabled=true;place?.isEnabled=true;error(e.message?:"保存失敗，可重試")}}}.start()};button(p,"返回（保留草稿）"){saveText();home()};updateStatus()
    }
    private fun saveText(){val id=currentId?:return;val value=editor?.text?.toString()?:return;val placeValue=place?.text?.toString()?:"";val row=store.read(id)?:return;if(row.optString("text")==value&&row.optJSONObject("location")?.optString("label","")==placeValue)return;store.mutate(id){it.put("text",value.take(100000));val loc=it.optJSONObject("location")?:JSONObject().put("status","unknown");loc.put("label",placeValue.take(500));it.put("location",loc)}}
    private fun updateStatus(){val row=currentId?.let{store.read(it)}?:return;val active=row.optBoolean("recording");recordingButton?.text=if(active)"停止錄音（持續保存片段）" else "開始錄音";val loc=row.optJSONObject("location")?:JSONObject();val desc=when(loc.optString("status")){"captured"->"${loc.optDouble("lat")}，${loc.optDouble("lon")}（精度約${loc.optDouble("accuracyMeters").toInt()}公尺）";"denied"->"未授權";"disabled"->"定位未開啟";"timeout"->"暫時未取得";"pending"->"取得中…";else->"未取得"};locationText?.text="地點：$desc（點此重試）";status?.text="${if(active)"正在錄音 · " else ""}已保存 ${row.getJSONArray("media").length()} 個附件\n${row.optString("recordingError","")}\n文字自動保存；辨識在電腦匯入後執行。";showAttachments(row,active)}
    private fun showAttachments(row:JSONObject,recording:Boolean){val host=attachments?:return;host.removeAllViews();val media=row.getJSONArray("media");for(i in 0 until media.length()){val item=media.getJSONObject(i);val audio=item.optString("type")=="audio";button(host,"${i+1}. ${if(audio)"錄音 ${(item.optLong("durationMs")/1000)} 秒" else "查看照片"}"){
        if(recording&&audio){error("請先停止錄音再回聽");return@button};val file=File(store.mediaDir(row.getString("id")),item.getString("file").substringAfterLast('/'))
        if(audio){try{player?.release();val next=android.media.MediaPlayer();player=next;next.setDataSource(file.path);next.setOnCompletionListener{it.release();if(player===it)player=null};next.prepare();next.start();AlertDialog.Builder(this).setTitle("原始錄音").setMessage("正在播放第${i+1}個附件").setPositiveButton("停止"){_,_->player?.release();player=null}.setOnCancelListener{player?.release();player=null}.show()}catch(e:Exception){error("無法播放：${e.message}")}}
        else{val bounds=android.graphics.BitmapFactory.Options().apply{inJustDecodeBounds=true};android.graphics.BitmapFactory.decodeFile(file.path,bounds);var sample=1;while(bounds.outWidth/sample>1600||bounds.outHeight/sample>1600)sample*=2;val bitmap=android.graphics.BitmapFactory.decodeFile(file.path,android.graphics.BitmapFactory.Options().apply{inSampleSize=sample});val image=ImageView(this).apply{setImageBitmap(bitmap);adjustViewBounds=true;maxHeight=(resources.displayMetrics.heightPixels*.6).toInt()};AlertDialog.Builder(this).setTitle("原始照片").setView(image).setPositiveButton("關閉",null).setOnDismissListener{image.setImageDrawable(null);bitmap?.recycle()}.show()}
    }}}
    private fun microphone(){if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){val names=if(Build.VERSION.SDK_INT>=33)arrayOf(Manifest.permission.RECORD_AUDIO,Manifest.permission.POST_NOTIFICATIONS)else arrayOf(Manifest.permission.RECORD_AUDIO);requestPermissions(names,101);return};currentId?.let{startForegroundService(Intent(this,RecordingService::class.java).putExtra("captureId",it));main.postDelayed({updateStatus()},700)}}
    private fun locate(){val id=currentId?:return;if(checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)!=PackageManager.PERMISSION_GRANTED&&checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION),202);return};val manager=getSystemService(LocationManager::class.java);val provider=if(manager.isProviderEnabled(LocationManager.GPS_PROVIDER))LocationManager.GPS_PROVIDER else if(manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER))LocationManager.NETWORK_PROVIDER else null;if(provider==null){store.mutate(id){it.getJSONObject("location").put("status","disabled")};updateStatus();return};store.mutate(id){it.getJSONObject("location").put("status","pending")};updateStatus();val listener=object:LocationListener{override fun onLocationChanged(value:Location){manager.removeUpdates(this);store.mutate(id){val loc=it.getJSONObject("location");loc.put("status","captured").put("lat",value.latitude).put("lon",value.longitude).put("accuracyMeters",value.accuracy).put("measuredAt",Instant.ofEpochMilli(value.time).toString()).put("provider",value.provider)};updateStatus()}};try{manager.requestSingleUpdate(provider,listener,main.looper);main.postDelayed({manager.removeUpdates(listener);if(store.read(id)?.optJSONObject("location")?.optString("status")=="pending"){store.mutate(id){it.getJSONObject("location").put("status","timeout")};updateStatus()}},6000)}catch(_:SecurityException){store.mutate(id){it.getJSONObject("location").put("status","denied")};updateStatus()}}
    override fun onRequestPermissionsResult(code:Int,permissions:Array<out String>,results:IntArray){super.onRequestPermissionsResult(code,permissions,results);if(code==101){if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)microphone()else error("未取得麥克風權限，仍可輸入文字與照片")};if(code==202){if(checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED||checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED)locate()else{currentId?.let{id->store.mutate(id){it.getJSONObject("location").put("status","denied")}};updateStatus()}}}
    override fun onActivityResult(code:Int,result:Int,data:Intent?){super.onActivityResult(code,result,data);if(result!=RESULT_OK)return;val id=currentId?:return;if(code==301){val mid=cameraId?:return;val f=File(store.mediaDir(id),"$mid.jpg");if(f.exists()&&f.length()>0)addPhoto(id,mid,f,"image/jpeg")else error("相機沒有回傳照片");cameraId=null};if(code==302){val uri=data?.data?:return;val mime=contentResolver.getType(uri)?:"";val ext=mapOf("image/jpeg" to "jpg","image/png" to "png","image/webp" to "webp")[mime];if(ext==null){error("第一版請選 JPG、PNG 或 WebP 照片");return};val mid=UUID.randomUUID().toString();val f=File(store.mediaDir(id),"$mid.$ext");busy=true;Thread{try{contentResolver.openInputStream(uri)!!.use{input->f.outputStream().use{out->val b=ByteArray(65536);var total=0;while(true){val n=input.read(b);if(n<0)break;total+=n;check(total<=25*1024*1024){"照片超過25MB"};out.write(b,0,n)}}};runOnUiThread{busy=false;addPhoto(id,mid,f,mime)}}catch(e:Exception){f.delete();runOnUiThread{busy=false;error(e.message?:"照片匯入失敗")}}}.start()}}
    private fun addPhoto(id:String,mid:String,f:File,mime:String){if(f.length()>25*1024*1024){error("照片超過25MB");return};val meta=store.mediaMeta(mid,f,"photo",mime);store.read(id)?.optJSONObject("location")?.let{meta.put("location",JSONObject(it.toString()))};store.addMedia(id,meta);updateStatus()}
    private fun error(message:String){AlertDialog.Builder(this).setTitle("墨脈隨手記").setMessage(message).setPositiveButton("知道了",null).show()}
    private fun receipt(value:Intent?){val encoded=value?.getStringExtra("inkgraph_receipt_b64")?:return;value.removeExtra("inkgraph_receipt_b64");try{
        require(encoded.length<16000);val envelope=JSONObject(String(Base64.decode(encoded,Base64.NO_WRAP),Charsets.UTF_8));val payload=Base64.decode(envelope.getString("payload"),Base64.NO_WRAP);val publicKey=envelope.getString("publicKey");val key=KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(publicKey,Base64.NO_WRAP)));val verifier=Signature.getInstance("SHA256withECDSA");verifier.initVerify(key);verifier.update(payload);require(verifier.verify(Base64.decode(envelope.getString("signature"),Base64.NO_WRAP))){"回執簽章不正確"};val p=JSONObject(String(payload,Charsets.UTF_8));val id=p.getString("captureId");val rev=p.getInt("revision");require(p.getString("deviceId")==store.deviceId);require(store.prefs.getString("export:$id:$rev",null)==p.getString("digest")){"回執與匯出版本不符"};val vault=p.getString("vaultId");val saved=store.prefs.getString("vault:$vault",null);require(saved==null||saved==publicKey){"電腦身分已變更，未接受回執"};val accept={store.prefs.edit().putString("vault:$vault",publicKey).putString("received:$id:$rev",p.getString("receivedAt")).apply();Toast.makeText(this,"已確認電腦接收原始檔；辨識可能仍在進行",Toast.LENGTH_LONG).show()};if(saved==null)AlertDialog.Builder(this).setTitle("確認接收電腦").setMessage("${p.optString("vaultName","墨脈研究庫")}\n指紋：${CaptureStore.sha(Base64.decode(publicKey,Base64.NO_WRAP)).take(16)}\n僅標示已接收，不刪除手機原檔。請核對電腦畫面。 ").setPositiveButton("信任此電腦"){_,_->accept()}.setNegativeButton("稍後",null).show()else accept()
    }catch(e:Exception){error("未接受匯入回執：${e.message}")}}
}
