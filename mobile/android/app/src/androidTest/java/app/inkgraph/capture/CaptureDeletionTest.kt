package app.inkgraph.capture

import android.test.InstrumentationTestCase
import android.provider.MediaStore
import java.io.File
import java.util.UUID

@Suppress("DEPRECATION")
class CaptureDeletionTest: InstrumentationTestCase() {
    fun testOnlySyntheticCaptureAndItsPackagesAreDeleted() {
        val context=instrumentation.targetContext
        val store=CaptureStore.get(context)
        assertFalse("Stop: a real recording is active",RecordingService.inProcessRecording)
        assertFalse("Stop: a capture is still recording",store.all().any{it.optBoolean("recording")})
        val before=store.all().map{it.getString("id")}.toSet()
        val row=store.create();val id=row.getString("id")
        try {
            store.mutate(id){it.put("text","INKGRAPH_SYNTHETIC_DELETE_TEST")}
            val mediaId=UUID.randomUUID().toString()
            val photo=File(store.mediaDir(id),"$mediaId.png")
            photo.writeBytes(byteArrayOf(1,2,3,4))
            store.addMedia(id,store.mediaMeta(mediaId,photo,"photo","image/png"))
            store.export(id)
            assertTrue(photo.exists())
            assertNotNull(store.prefs.getString("export:$id:1",null))
            store.mutate(id){it.put("recording",true)}
            var rejected=false
            try{store.deleteCapture(id)}catch(_:IllegalStateException){rejected=true}
            assertTrue("Recording capture must reject deletion",rejected)
            assertNotNull(store.read(id));assertTrue(photo.exists())
            store.mutate(id){it.put("recording",false)}
            store.deleteCapture(id)
            store.updateLocationIfPresent(id){it.put("status","captured")}
            assertNull(store.read(id));assertFalse(photo.exists())
            assertFalse(File(context.filesDir,"exports/$id-r1.json").exists())
            assertNull(store.prefs.getString("export:$id:1",null))
            context.contentResolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,arrayOf(MediaStore.Downloads.DISPLAY_NAME),"${MediaStore.Downloads.RELATIVE_PATH}=?",arrayOf("Download/InkGraph-Capture/${store.deviceId}/"),null)!!.use{cursor->
                while(cursor.moveToNext())assertFalse("Synthetic outbox package remains",cursor.getString(0).startsWith("$id-r"))
            }
            assertEquals(before,store.all().map{it.getString("id")}.toSet())
        } finally {
            store.read(id)?.let{store.mutate(id){it.put("recording",false)};store.deleteCapture(id)}
        }
    }
}
