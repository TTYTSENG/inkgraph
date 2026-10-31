package app.inkgraph.capture

import android.test.InstrumentationTestCase
import android.graphics.Bitmap
import java.io.File
import java.util.UUID

@Suppress("DEPRECATION")
class CaptureExperienceTest: InstrumentationTestCase(){
    fun testCurrentVersionReceiptAndDraftAreDistinct(){
        val store=CaptureStore.get(instrumentation.targetContext)
        assertFalse(store.all().any{it.optBoolean("recording")})
        val before=store.all().associate{it.getString("id") to CaptureStore.sha(it.toString().toByteArray())}
        val row=store.create();val id=row.getString("id")
        try{
            assertEquals("draft",store.presentation(row).phase)
            store.mutate(id){it.put("text","IGSTATUS20261031")};store.export(id)
            assertEquals("pending",store.presentation(store.read(id)!!).phase)
            store.prefs.edit().putString("received:$id:1","synthetic-test").commit()
            assertEquals("received",store.presentation(store.read(id)!!).phase)
            store.mutate(id){it.put("revision",2);it.put("completed",false)}
            assertEquals("draft",store.presentation(store.read(id)!!).phase)
            assertTrue(store.presentation(store.read(id)!!).state.contains("新版"))
        }finally{store.deleteCapture(id)}
        assertEquals(before,store.all().associate{it.getString("id") to CaptureStore.sha(it.toString().toByteArray())})
    }
    // Explicitly selected by the UI runner; only this marked fixture is disposable.
    fun testPrepareLongListFixture(){
        val store=CaptureStore.get(instrumentation.targetContext)
        assertFalse(store.all().any{it.optBoolean("recording")})
        assertFalse(store.all().any{it.optString("text")=="IGLAYOUT20261031"})
        val row=store.create();val id=row.getString("id")
        store.mutate(id){it.put("text","IGLAYOUT20261031")}
        val bitmap=Bitmap.createBitmap(32,32,Bitmap.Config.ARGB_8888)
        for(i in 1..24){val mediaId=UUID.randomUUID().toString();val file=File(store.mediaDir(id),"$mediaId.png");file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};store.addMedia(id,store.mediaMeta(mediaId,file,"photo","image/png"))}
        bitmap.recycle()
        assertEquals(24,store.read(id)!!.getJSONArray("media").length())
    }
}
