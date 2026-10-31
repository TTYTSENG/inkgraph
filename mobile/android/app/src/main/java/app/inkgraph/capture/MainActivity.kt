package app.inkgraph.capture

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.location.*
import android.net.Uri
import android.os.*
import android.provider.MediaStore
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
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
    private var openedId:String?=null
    private var page="home"
    private var homeFilter="all"
    private var homeScroll=0
    private var editor:EditText?=null
    private var place:EditText?=null
    private var locationText:TextView?=null
    private var saveIndicator:TextView?=null
    private var recordingButton:Button?=null
    private var recordingHost:LinearLayout?=null
    private var recordingLabel:TextView?=null
    private var recordingId:String?=null
    private var status:TextView?=null
    private var attachments:LinearLayout?=null
    private var attachmentKey=""
    private var metadata:LinearLayout?=null
    private var scroll:ScrollView?=null
    private var player:android.media.MediaPlayer?=null
    private var cameraId:String?=null
    private var busy=false
    private var recordingStarting=false
    private val main=Handler(Looper.getMainLooper())
    private val autosave=Runnable{saveText()}
    private val tick=object:Runnable{override fun run(){updateRecordingTime();main.postDelayed(this,1000)}}
    private val changed=object:BroadcastReceiver(){override fun onReceive(c:Context?,i:Intent?){recordingStarting=false;if(page=="home")home()else updateStatus()}}
    private val green=Color.rgb(23,62,53)
    private val paper=Color.rgb(246,245,238)
    private fun dp(value:Int)=(value*resources.displayMetrics.density).toInt()

    override fun onCreate(state:Bundle?){
        super.onCreate(state);store=CaptureStore.get(this)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if(!RecordingService.inProcessRecording)RecordingService.recover(store)
        cameraId=state?.getString("cameraId");homeFilter=state?.getString("homeFilter")?:"all";homeScroll=state?.getInt("homeScroll")?:0
        registerReceiver(changed,IntentFilter("app.inkgraph.capture.CHANGED"),Context.RECEIVER_NOT_EXPORTED)
        if(Build.VERSION.SDK_INT>=33)onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT){back()}
        val id=state?.getString("captureId");val row=id?.let{store.read(it)}
        if(row!=null){if(row.optBoolean("completed"))review(id!!)else compose(id!!)}else home()
        receipt(intent)
    }
    override fun onNewIntent(value:Intent){super.onNewIntent(value);setIntent(value);receipt(value)}
    override fun onResume(){super.onResume();main.removeCallbacks(tick);main.post(tick);if(::store.isInitialized){if(page=="home")home()else updateStatus()}}
    override fun onSaveInstanceState(out:Bundle){saveText();out.putString("captureId",openedId);out.putString("cameraId",cameraId);out.putString("homeFilter",homeFilter);out.putInt("homeScroll",homeScroll);super.onSaveInstanceState(out)}
    override fun onPause(){saveText();main.removeCallbacks(tick);super.onPause()}
    override fun onDestroy(){main.removeCallbacks(autosave);main.removeCallbacks(tick);player?.release();unregisterReceiver(changed);super.onDestroy()}
    @Deprecated("Framework callback for older Android") override fun onBackPressed(){back()}
    private fun back(){if(busy){error("正在保存原始檔，請稍候");return};if(page=="home")moveTaskToBack(true)else if(saveText())home()}

    private fun label(parent:LinearLayout,value:String,size:Float=16f):TextView=TextView(this).apply{
        text=value;textSize=size;setTextColor(green);setPadding(0,dp(6),0,dp(8));parent.addView(this)
    }
    private fun button(parent:LinearLayout,title:String,primary:Boolean=false,action:()->Unit):Button=Button(this).apply{
        text=title;textSize=15f;isAllCaps=false;minHeight=dp(48);minimumHeight=dp(48);setPadding(dp(10),dp(8),dp(10),dp(8))
        setTextColor(if(primary)Color.WHITE else green)
        background=GradientDrawable().apply{setColor(if(primary)green else Color.WHITE);cornerRadius=dp(9).toFloat();if(!primary)setStroke(dp(1),Color.rgb(217,225,215))}
        setOnClickListener{if(busy)Toast.makeText(this@MainActivity,"正在保存原始檔，請稍候",Toast.LENGTH_SHORT).show()else action()}
        parent.addView(this,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(8)})
    }
    private fun footerButton(parent:LinearLayout,title:String,primary:Boolean=false,action:()->Unit):Button {
        val result=button(parent,title,primary,action)
        result.layoutParams=LinearLayout.LayoutParams(0,-2,if(primary)1.5f else 1f).apply{marginStart=dp(3);marginEnd=dp(3)}
        return result
    }
    private fun screen(title:String,backButton:Boolean=false,footer:(LinearLayout)->Unit):LinearLayout {
        editor=null;place=null;locationText=null;attachments=null;attachmentKey="";recordingButton=null;metadata=null;saveIndicator=null;status=null
        val root=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setBackgroundColor(paper)}
        root.setOnApplyWindowInsetsListener{view,insets->
            val bars=if(Build.VERSION.SDK_INT>=30)insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())else null
            @Suppress("DEPRECATION")
            view.setPadding(dp(16)+(bars?.left?:insets.systemWindowInsetLeft),bars?.top?:insets.systemWindowInsetTop,dp(16)+(bars?.right?:insets.systemWindowInsetRight),bars?.bottom?:insets.systemWindowInsetBottom)
            insets
        }
        val header=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=android.view.Gravity.CENTER_VERTICAL;root.addView(this)}
        if(backButton)button(header,"返回"){back()}.apply{layoutParams=LinearLayout.LayoutParams(-2,-2).apply{marginEnd=dp(10)}}
        label(header,title,23f).apply{setTypeface(typeface,Typeface.BOLD);layoutParams=LinearLayout.LayoutParams(0,-2,1f)}
        if(backButton)button(header,"更多"){more()}.apply{layoutParams=LinearLayout.LayoutParams(-2,-2)}
        if(page=="compose")saveIndicator=label(root,"已保存草稿",13f).apply{accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE}
        recordingHost=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;root.addView(this)}
        scroll=ScrollView(this).apply{isFillViewport=true;root.addView(this,LinearLayout.LayoutParams(-1,0,1f))}
        val body=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(0,dp(10),0,dp(16));isFocusableInTouchMode=true;scroll!!.addView(this)}
        val bottom=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=android.view.Gravity.CENTER_VERTICAL;setPadding(0,dp(8),0,dp(10));root.addView(this)}
        footer(bottom);setContentView(root);root.requestApplyInsets();body.requestFocus();return body
    }
    private fun received(row:JSONObject)=store.presentation(row).phase=="received"
    private fun time(row:JSONObject)=try{DateTimeFormatter.ofPattern("MM/dd HH:mm").withZone(ZoneId.of(row.getString("timezone"))).format(Instant.parse(row.getString("createdAt")))}catch(_:Exception){row.optString("createdAt")}
    private fun open(id:String){
        val active=store.all().find{it.optBoolean("recording")}
        if(active!=null&&active.getString("id")!=id){error("另一則記錄仍在錄音，請先回到錄音記錄並停止保存");return}
        val row=store.read(id)?:return;if(row.optBoolean("completed"))review(id)else compose(id)
    }
    private fun startNew(){
        homeScroll=scroll?.scrollY?:homeScroll
        val active=store.all().find{it.optBoolean("recording")};if(active!=null){compose(active.getString("id"));return}
        val row=store.create();compose(row.getString("id"));locate()
    }
    private fun home(){
        if(page=="home")homeScroll=scroll?.scrollY?:homeScroll
        page="home";currentId=null;openedId=null
        val p=screen("墨脈隨手記"){footerButton(it,"新增筆記",true){startNew()}}
        label(p,"點選記錄即可繼續；想法、照片與錄音保存在手機。",14f)
        val rows=store.all()
        val filterRows=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;p.addView(this)}
        var filters=LinearLayout(this)
        for((index,pair) in listOf("all" to "全部","draft" to "草稿","pending" to "可傳輸","received" to "已接收").withIndex()){
            val (key,name)=pair
            if(index%2==0)filters=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;filterRows.addView(this)}
            val count=rows.count{val phase=store.presentation(it).phase;key=="all"||phase==key||(key=="draft"&&phase=="recording")}
            button(filters,"$name $count",key==homeFilter){homeFilter=key;scroll?.scrollTo(0,0);homeScroll=0;home()}.apply{isSelected=key==homeFilter;layoutParams=LinearLayout.LayoutParams(0,-2,1f).apply{marginEnd=dp(6);topMargin=dp(6)}}
        }
        val shown=rows.filter{val phase=store.presentation(it).phase;homeFilter=="all"||phase==homeFilter||(homeFilter=="draft"&&phase=="recording")}
        label(p,if(shown.isEmpty())"此分類沒有記錄。新增一則想法，或切換其他分類。" else "${shown.size} 則記錄 · 點選整列開啟",14f)
        for(row in shown){val info=store.presentation(row)
            button(p,"${info.title}\n${info.state} · ${time(row)}\n${info.details}"){
                homeScroll=scroll?.scrollY?:0;open(row.getString("id"))
            }.apply{gravity=android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL;contentDescription="開啟記錄：${info.title}";setPadding(dp(14),dp(12),dp(14),dp(12))}
        }
        label(p,"完成記錄後可用 USB 交給電腦。\n「此版本已接收」代表電腦已保存；辨識進度請看電腦。",13f)
        refreshRecordingBar();scroll?.post{scroll?.scrollTo(0,homeScroll)}
    }
    private fun more(){
        val id=openedId?:return
        AlertDialog.Builder(this).setTitle("記錄管理").setItems(arrayOf("時間與地點","刪除此記錄")){_,which->
            if(which==0){metadata?.visibility=View.VISIBLE;scroll?.smoothScrollTo(0,0)}else confirmDelete(id)
        }.setNegativeButton("取消",null).show()
    }
    private fun metadata(parent:LinearLayout,row:JSONObject,editable:Boolean){
        val holder=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;visibility=View.GONE;parent.addView(this)};metadata=holder
        label(holder,"記錄時間：${row.getString("createdAt")}\n時區：${row.getString("timezone")} · 第${row.getInt("revision")}版",13f)
        locationText=label(holder,"地點狀態",14f).apply{if(editable)setOnClickListener{locate()}}
        if(editable)place=EditText(this).apply{hint="地點名稱（選填）";setSingleLine();setText(row.optJSONObject("location")?.optString("label")?:"");holder.addView(this)}
        else label(holder,"地點名稱：${row.optJSONObject("location")?.optString("label")?.ifBlank{"未填"}?:"未填"}",14f)
    }
    private fun review(id:String){
        val row=store.read(id)?:return;page="review";currentId=null;openedId=id
        val p=screen("記錄詳情",true){footerButton(it,"編輯記錄",true){
            store.mutate(id){r->r.put("revision",r.getInt("revision")+1);r.put("completed",false);r.remove("completedAt")};compose(id)
        }}
        label(p,store.presentation(row).state,18f)
        label(p,if(received(row))"電腦已保存此版本的原始檔；辨識與校對請在電腦查看。" else "手機已保存，傳輸包已準備。接上 USB 後，在電腦墨脈接收記錄。",14f)
        label(p,"${time(row)} · ${store.presentation(row).details}",14f)
        button(p,"查看時間與地點"){metadata?.visibility=if(metadata?.visibility==View.VISIBLE)View.GONE else View.VISIBLE}
        metadata(p,row,false)
        label(p,row.optString("text").ifBlank{"此則以照片／語音記錄想法。"},18f)
        attachments=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;p.addView(this)};showAttachments(row,false)
        label(p,"編輯後會保留已傳版本，另存新版草稿。",13f);refreshRecordingBar()
    }
    private fun compose(id:String){
        val row=store.read(id)?:return;page="compose";currentId=id;openedId=id
        val p=screen("編輯筆記",true){bar->
            recordingButton=footerButton(bar,"錄音"){toggleRecording()}
            footerButton(bar,"照片"){photoOptions()}
            footerButton(bar,"完成記錄",true){finishCapture()}
        }
        label(p,if(row.optInt("revision",1)>1)"這是新版草稿；完成後才可再次傳到電腦。" else "文字自動保存，完成後可傳至電腦。",13f)
        button(p,"時間與地點（選填）"){metadata?.visibility=if(metadata?.visibility==View.VISIBLE)View.GONE else View.VISIBLE}
        metadata(p,row,true)
        label(p,"此刻的想法",16f)
        editor=EditText(this).apply{hint="寫下想法，或用下方錄音／照片補充…";minLines=6;gravity=android.view.Gravity.TOP;textSize=18f;setText(row.optString("text"));p.addView(this)}
        val watcher=object:TextWatcher{
            override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){}
            override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){saveIndicator?.text="正在保存變更…";main.removeCallbacks(autosave);main.postDelayed(autosave,600)}
            override fun afterTextChanged(s:Editable?){}
        }
        editor!!.addTextChangedListener(watcher);place!!.addTextChangedListener(watcher)
        status=label(p,"",14f)
        attachments=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;p.addView(this)}
        updateStatus()
    }
    private fun saveText():Boolean {
        val id=currentId?:return true;val value=editor?.text?.toString()?:return true;val placeValue=place?.text?.toString()?:""
        return try{
            val row=store.read(id)?:return true
            if(row.optString("text")!=value||row.optJSONObject("location")?.optString("label","")!=placeValue){
                require(value.length<=100000){"文字超過十萬字，請分成其他記錄"}
                store.mutate(id){it.put("text",value);val loc=it.optJSONObject("location")?:JSONObject().put("status","unknown");loc.put("label",placeValue.take(500));it.put("location",loc)}
            }
            saveIndicator?.text="已保存草稿";true
        }catch(e:Exception){saveIndicator?.text="尚未保存：${e.message}。請保留畫面後重試。";false}
    }
    private fun finishCapture(){
        val id=currentId?:return;if(!saveText())return
        if(recordingStarting||store.read(id)?.optBoolean("recording")==true||RecordingService.inProcessRecording){error("請先停止錄音，等片段保存完成");return}
        busy=true;editor?.isEnabled=false;place?.isEnabled=false;saveIndicator?.text="正在保存原始檔並準備傳輸…"
        Thread{try{store.export(id);runOnUiThread{busy=false;Toast.makeText(this,"記錄已完成，可傳至電腦",Toast.LENGTH_LONG).show();home()}}
            catch(e:Exception){runOnUiThread{busy=false;editor?.isEnabled=true;place?.isEnabled=true;saveIndicator?.text="草稿已保留，完成失敗可重試";error(e.message?:"完成失敗")}}}.start()
    }
    private fun confirmDelete(id:String){
        if(busy||!saveText())return;val row=store.read(id)?:return
        if(recordingStarting||RecordingService.inProcessRecording||row.optBoolean("recording")){error("請先停止錄音，等片段保存完成");return}
        val state=if(received(row))"此版本已收到電腦接收回執。" else "此版本尚未確認傳到電腦，刪除後可能無法取回。"
        AlertDialog.Builder(this).setTitle("刪除此記錄？").setMessage("$state\n\n將刪除手機這則記錄、${row.getJSONArray("media").length()} 個原始附件及此記錄所有版本的傳輸包。無法復原。已匯入電腦的資料會保留。")
            .setNegativeButton("取消",null).setPositiveButton("確認刪除"){_,_->
                val editing=currentId==id;busy=true;main.removeCallbacks(autosave);currentId=null;editor?.isEnabled=false;place?.isEnabled=false;player?.release();player=null
                Thread{try{store.deleteCapture(id);runOnUiThread{busy=false;home();Toast.makeText(this,"已刪除手機記錄",Toast.LENGTH_SHORT).show()}}
                    catch(e:Exception){runOnUiThread{busy=false;if(editing)currentId=id;editor?.isEnabled=true;place?.isEnabled=true;error(e.message?:"刪除失敗，請重試")}}}.start()
            }.show()
    }
    private fun refreshRecordingBar(){
        val host=recordingHost?:return;host.removeAllViews();recordingLabel=null
        val row=store.all().find{it.optBoolean("recording")};recordingId=row?.getString("id")
        if(row==null){host.visibility=View.GONE;return};host.visibility=View.VISIBLE
        recordingLabel=label(host,"正在錄音 · 已保存的片段會保留",15f)
        val controls=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;host.addView(this)}
        if(currentId!=recordingId)footerButton(controls,"回到錄音"){if(saveText())compose(row.getString("id"))}
        footerButton(controls,"停止並保存",true){stopRecording()};updateRecordingTime()
    }
    private fun updateRecordingTime(){
        val row=recordingId?.let{store.read(it)}?:return;if(!row.optBoolean("recording"))return
        var seconds=0L;val media=row.getJSONArray("media")
        for(i in 0 until media.length())if(media.getJSONObject(i).optString("type")=="audio")seconds+=media.getJSONObject(i).optLong("durationMs")/1000
        val inflight=row.optJSONObject("inflight")?.optString("capturedAt")
        if(!inflight.isNullOrBlank())seconds+=try{java.time.Duration.between(Instant.parse(inflight),Instant.now()).seconds.coerceAtLeast(0)}catch(_:Exception){0}
        recordingLabel?.text="正在錄音 ${seconds/60}:${(seconds%60).toString().padStart(2,'0')} · 片段持續保存"
    }
    private fun updateStatus(){
        refreshRecordingBar();val row=currentId?.let{store.read(it)}?:return
        val active=row.optBoolean("recording");recordingButton?.text=if(active)"停止錄音" else if(recordingStarting)"準備中…" else "錄音"
        val loc=row.optJSONObject("location")?:JSONObject()
        val desc=when(loc.optString("status")){"captured"->"${loc.optDouble("lat")}，${loc.optDouble("lon")}（精度約${loc.optDouble("accuracyMeters").toInt()}公尺）";"denied"->"未授權";"disabled"->"定位未開啟";"timeout"->"暫時未取得";"pending"->"取得中…";else->"未取得"}
        locationText?.text="地點：$desc（點此重試）"
        status?.text="${store.presentation(row).details}\n${row.optString("recordingError","")}".trim()
        showAttachments(row,active)
    }
    private fun showAttachments(row:JSONObject,recording:Boolean){
        val host=attachments?:return;val media=row.getJSONArray("media");val key=media.toString()+recording
        if(key==attachmentKey)return;attachmentKey=key;host.removeAllViews()
        for(i in 0 until media.length()){val item=media.getJSONObject(i);val audio=item.optString("type")=="audio"
            button(host,"${i+1}. ${if(audio)"播放錄音 ${item.optLong("durationMs")/1000} 秒" else "查看照片"}"){
                if(recording&&audio){error("請先停止錄音再回聽");return@button}
                val file=File(store.mediaDir(row.getString("id")),item.getString("file").substringAfterLast('/'))
                if(audio){try{
                    player?.release();val next=android.media.MediaPlayer();player=next;next.setDataSource(file.path);next.setOnCompletionListener{it.release();if(player===it)player=null};next.prepare();next.start()
                    AlertDialog.Builder(this).setTitle("原始錄音").setMessage("正在播放第${i+1}個附件").setPositiveButton("停止"){_,_->player?.release();player=null}.setOnCancelListener{player?.release();player=null}.show()
                }catch(e:Exception){error("無法播放：${e.message}")}}
                else{val bounds=android.graphics.BitmapFactory.Options().apply{inJustDecodeBounds=true};android.graphics.BitmapFactory.decodeFile(file.path,bounds);var sample=1
                    while(bounds.outWidth/sample>1600||bounds.outHeight/sample>1600)sample*=2
                    val bitmap=android.graphics.BitmapFactory.decodeFile(file.path,android.graphics.BitmapFactory.Options().apply{inSampleSize=sample})
                    val image=ImageView(this).apply{setImageBitmap(bitmap);adjustViewBounds=true;maxHeight=(resources.displayMetrics.heightPixels*.6).toInt()}
                    AlertDialog.Builder(this).setTitle("原始照片").setView(image).setPositiveButton("關閉",null).setOnDismissListener{image.setImageDrawable(null);bitmap?.recycle()}.show()
                }
            }
        }
    }
    private fun toggleRecording(){if(!saveText())return;if(store.read(currentId?:return)?.optBoolean("recording")==true)stopRecording()else if(!recordingStarting)microphone()}
    private fun stopRecording(){recordingLabel?.text="正在停止並保存錄音…";startService(Intent(this,RecordingService::class.java).setAction("stop"));main.postDelayed({updateStatus()},700)}
    private fun microphone(){
        if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){val names=if(Build.VERSION.SDK_INT>=33)arrayOf(Manifest.permission.RECORD_AUDIO,Manifest.permission.POST_NOTIFICATIONS)else arrayOf(Manifest.permission.RECORD_AUDIO);requestPermissions(names,101);return}
        currentId?.let{recordingStarting=true;recordingButton?.text="準備中…";startForegroundService(Intent(this,RecordingService::class.java).putExtra("captureId",it));main.postDelayed({recordingStarting=false;updateStatus()},700)}
    }
    private fun photoOptions(){if(!saveText())return;AlertDialog.Builder(this).setTitle("加入照片").setItems(arrayOf("拍攝照片","選取一張照片")){_,i->if(i==0)camera()else startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE),302)}.setNegativeButton("取消",null).show()}
    private fun camera(){val id=currentId?:return;cameraId=UUID.randomUUID().toString();val uri=Uri.parse("content://$packageName.files/$id/$cameraId.jpg");val intent=Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION);try{startActivityForResult(intent,301)}catch(e:Exception){error("無法開啟相機：${e.message}")}}
    private fun locate(){
        val id=currentId?:return
        if(checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)!=PackageManager.PERMISSION_GRANTED&&checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION),202);return}
        val manager=getSystemService(LocationManager::class.java)
        val provider=if(manager.isProviderEnabled(LocationManager.GPS_PROVIDER))LocationManager.GPS_PROVIDER else if(manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER))LocationManager.NETWORK_PROVIDER else null
        if(provider==null){store.updateLocationIfPresent(id){it.put("status","disabled")};updateStatus();return}
        store.updateLocationIfPresent(id){it.put("status","pending")};updateStatus()
        val listener=object:LocationListener{override fun onLocationChanged(value:Location){manager.removeUpdates(this);store.updateLocationIfPresent(id){loc->loc.put("status","captured").put("lat",value.latitude).put("lon",value.longitude).put("accuracyMeters",value.accuracy).put("measuredAt",Instant.ofEpochMilli(value.time).toString()).put("provider",value.provider)};updateStatus()}}
        try{manager.requestSingleUpdate(provider,listener,main.looper);main.postDelayed({manager.removeUpdates(listener);if(store.read(id)?.optJSONObject("location")?.optString("status")=="pending"){store.updateLocationIfPresent(id){it.put("status","timeout")};updateStatus()}},6000)}catch(_:SecurityException){store.updateLocationIfPresent(id){it.put("status","denied")};updateStatus()}
    }
    override fun onRequestPermissionsResult(code:Int,permissions:Array<out String>,results:IntArray){
        super.onRequestPermissionsResult(code,permissions,results)
        if(code==101){if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)microphone()else error("未取得麥克風權限，仍可輸入文字與照片")}
        if(code==202){if(checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED||checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED)locate()else{currentId?.let{id->store.updateLocationIfPresent(id){it.put("status","denied")}};updateStatus()}}
    }
    override fun onActivityResult(code:Int,result:Int,data:Intent?){
        super.onActivityResult(code,result,data);if(result!=RESULT_OK)return;val id=currentId?:return
        if(code==301){val mid=cameraId?:return;val file=File(store.mediaDir(id),"$mid.jpg");if(file.exists()&&file.length()>0)addPhoto(id,mid,file,"image/jpeg")else error("相機沒有回傳照片");cameraId=null}
        if(code==302){val uri=data?.data?:return;val mime=contentResolver.getType(uri)?:"";val ext=mapOf("image/jpeg" to "jpg","image/png" to "png","image/webp" to "webp")[mime]
            if(ext==null){error("第一版請選 JPG、PNG 或 WebP 照片");return};val mid=UUID.randomUUID().toString();val file=File(store.mediaDir(id),"$mid.$ext");busy=true
            Thread{try{contentResolver.openInputStream(uri)!!.use{input->file.outputStream().use{out->val bytes=ByteArray(65536);var total=0;while(true){val n=input.read(bytes);if(n<0)break;total+=n;check(total<=25*1024*1024){"照片超過25MB"};out.write(bytes,0,n)}}};runOnUiThread{busy=false;addPhoto(id,mid,file,mime)}}catch(e:Exception){file.delete();runOnUiThread{busy=false;error(e.message?:"照片匯入失敗")}}}.start()
        }
    }
    private fun addPhoto(id:String,mid:String,file:File,mime:String){if(file.length()>25*1024*1024){error("照片超過25MB");return};val meta=store.mediaMeta(mid,file,"photo",mime);store.read(id)?.optJSONObject("location")?.let{meta.put("location",JSONObject(it.toString()))};store.addMedia(id,meta);updateStatus()}
    private fun error(message:String){AlertDialog.Builder(this).setTitle("墨脈隨手記").setMessage(message).setPositiveButton("知道了",null).show()}
    private fun receipt(value:Intent?){
        val encoded=value?.getStringExtra("inkgraph_receipt_b64")?:return;value.removeExtra("inkgraph_receipt_b64")
        try{
            require(encoded.length<16000);val envelope=JSONObject(String(Base64.decode(encoded,Base64.NO_WRAP),Charsets.UTF_8));val payload=Base64.decode(envelope.getString("payload"),Base64.NO_WRAP);val publicKey=envelope.getString("publicKey")
            val key=KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(publicKey,Base64.NO_WRAP)));val verifier=Signature.getInstance("SHA256withECDSA");verifier.initVerify(key);verifier.update(payload);require(verifier.verify(Base64.decode(envelope.getString("signature"),Base64.NO_WRAP))){"回執簽章不正確"}
            val p=JSONObject(String(payload,Charsets.UTF_8));val id=p.getString("captureId");val revision=p.getInt("revision");require(p.getString("deviceId")==store.deviceId);require(store.prefs.getString("export:$id:$revision",null)==p.getString("digest")){"回執與匯出版本不符"}
            val vault=p.getString("vaultId");val saved=store.prefs.getString("vault:$vault",null);require(saved==null||saved==publicKey){"電腦身分已變更，未接受回執"}
            val accept={store.prefs.edit().putString("vault:$vault",publicKey).putString("received:$id:$revision",p.getString("receivedAt")).apply();if(page=="home")home()else if(page=="review"&&openedId==id)review(id)else updateStatus();Toast.makeText(this,"已確認電腦保存此版本；辨識請在電腦查看",Toast.LENGTH_LONG).show()}
            if(saved==null)AlertDialog.Builder(this).setTitle("確認接收電腦").setMessage("${p.optString("vaultName","墨脈研究庫")}\n指紋：${CaptureStore.sha(Base64.decode(publicKey,Base64.NO_WRAP)).take(16)}\n僅標示已接收，不刪除手機原檔。請核對電腦畫面。").setPositiveButton("信任此電腦"){_,_->accept()}.setNegativeButton("稍後",null).show()else accept()
        }catch(e:Exception){error("未接受匯入回執：${e.message}")}
    }
}
