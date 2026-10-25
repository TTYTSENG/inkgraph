package app.inkgraph.capture
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
class CaptureProvider: ContentProvider() {
    override fun onCreate()=true
    private fun file(uri: Uri): File { val p=uri.pathSegments;require(p.size==2&&p.all{it.matches(Regex("[a-f0-9-]{36}(\\.jpg)?"))});val f=File(CaptureStore.get(context!!).mediaDir(p[0]),p[1]);require(f.canonicalPath.startsWith(context!!.filesDir.canonicalPath+File.separator));return f }
    override fun openFile(uri: Uri, mode: String)=ParcelFileDescriptor.open(file(uri),if(mode.contains("w"))ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE else ParcelFileDescriptor.MODE_READ_ONLY)
    override fun getType(uri: Uri)="image/jpeg"
    override fun query(uri: Uri,projection:Array<out String>?,selection:String?,selectionArgs:Array<out String>?,sortOrder:String?):Cursor=MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE)).apply{val f=file(uri);addRow(arrayOf(f.name,f.length()))}
    override fun insert(uri: Uri,values: ContentValues?):Uri?=null
    override fun update(uri: Uri,values:ContentValues?,selection:String?,selectionArgs:Array<out String>?)=0
    override fun delete(uri: Uri,selection:String?,selectionArgs:Array<out String>?)=0
}
