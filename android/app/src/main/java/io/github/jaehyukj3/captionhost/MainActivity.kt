package io.github.jaehyukj3.captionhost

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 송출 화면(사이트의 /host)을 그대로 띄우고, 음성인식만 앱이 직접 한다.
 * 방 만들기·암호화·참석자 연결은 웹 송출과 똑같이 화면(자바스크립트)이 맡는다.
 *
 * 화면 ↔ 앱 연결
 *  - 화면 → 앱: window.CaptionNative.prepare() / start() / stop() / saveFile(이름, 형식, base64) / recentAudio() / version()
 *  - 앱 → 화면: window.__captionNative.emit({op: ...})
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val site = Uri.parse(BuildConfig.SITE)
    private val models by lazy { ModelStore(this, BuildConfig.SITE) }
    private val engine = SpeechEngine(::emit)
    /** 모델 준비·마이크 켜고 끄기는 차례대로 (인식 자체는 SpeechEngine의 스레드에서) */
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var preparing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 화면이 꺼지면 송출이 멈추므로 켜 둔다
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString CaptionHostApp/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(Bridge(), "CaptionNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (isHostPage(request.url)) return false
                // 참석자 화면 링크 등은 브라우저로 연다 (이 화면에서 벗어나면 송출이 끝나므로)
                openExternal(request.url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                // 화면을 새로 열면(새로고침 등) 이전 화면이 켜 둔 마이크는 끈다
                worker.execute { engine.stop() }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // 화면이 브라우저 방식(기기 안 인식 WebAssembly)을 고른 경우를 위한 마이크 허용
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val wantsMic = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
                    if (wantsMic && request.origin.host == site.host && hasMic()) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    else request.deny()
                }
            }
        }
        web.loadUrl("${BuildConfig.SITE}/host")
        checkUpdate()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) {
            web.goBack()
            return
        }
        AlertDialog.Builder(this)
            .setMessage("앱을 닫을까요? 송출 중이면 자막이 끝납니다.")
            .setPositiveButton("닫기") { _, _ -> finish() }
            .setNegativeButton("취소", null)
            .show()
    }

    override fun onDestroy() {
        worker.execute { engine.stop() }
        worker.shutdown()
        web.destroy()
        super.onDestroy()
    }

    private fun isHostPage(uri: Uri?) =
        uri != null && uri.scheme == site.scheme && uri.host == site.host && (uri.path ?: "").let { it == "/host" || it.startsWith("/host/") }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(this, "열 수 있는 앱이 없습니다: $uri", Toast.LENGTH_LONG).show()
        }
    }

    private fun hasMic() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** 앱 → 화면 알림 */
    private fun emit(event: JSONObject) {
        val js = "window.__captionNative && window.__captionNative.emit($event)"
        web.post { web.evaluateJavascript(js, null) }
    }

    private fun prepare() {
        if (engine.isLoaded) {
            emit(SpeechEngine.event("ready"))
            return
        }
        if (preparing) return
        preparing = true
        worker.execute {
            try {
                var lastPct = -1L
                val model = models.ensure { loaded, total ->
                    val pct = loaded * 100 / total
                    if (pct != lastPct) {
                        lastPct = pct
                        emit(SpeechEngine.event("progress").put("loaded", loaded).put("total", total))
                    }
                }
                emit(SpeechEngine.event("loading"))
                engine.load(model)
                emit(SpeechEngine.event("ready"))
            } catch (e: Throwable) {
                emit(SpeechEngine.event("error").put("where", "prepare").put("message", e.message ?: e.toString()))
            } finally {
                preparing = false
            }
        }
    }

    private fun startMic() {
        worker.execute {
            val err = engine.start()
            if (err == null) emit(SpeechEngine.event("listening"))
            else emit(SpeechEngine.event("micError").put("message", err))
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        if (hasMic()) {
            startMic()
            return
        }
        // 다시 묻지 않음 상태면 설정 화면으로 안내
        val blocked = !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
        emit(
            SpeechEngine.event("micError").put(
                "message",
                if (blocked) "마이크 권한이 꺼져 있습니다. 휴대폰 설정 → 애플리케이션 → 강의 자막 송출 → 권한에서 마이크를 허용해 주세요."
                else "마이크 권한이 거부되었습니다. 다시 ‘마이크 시작’을 누르고 허용해 주세요.",
            ),
        )
        if (blocked) {
            runOnUiThread {
                AlertDialog.Builder(this)
                    .setMessage("마이크 권한이 꺼져 있습니다. 설정에서 허용해 주세요.")
                    .setPositiveButton("설정 열기") { _, _ ->
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                    }
                    .setNegativeButton("취소", null)
                    .show()
            }
        }
    }

    /** 파일을 다운로드 폴더에 저장 (화면의 '자막 저장' 등) */
    private fun save(name: String, mime: String, bytes: ByteArray) {
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("저장 위치를 만들지 못했습니다")
                contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE)
                    error("저장 권한을 허용한 뒤 다시 눌러 주세요")
                }
                dir.mkdirs()
                File(dir, safe).writeBytes(bytes)
            }
            toast("다운로드 폴더에 저장했습니다: $safe")
        } catch (e: Exception) {
            toast("저장하지 못했습니다: ${e.message}")
        }
    }

    private fun toast(message: String) = runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }

    /** 새 버전이 있으면 받기 안내 (사이트의 /app/version.json) */
    private fun checkUpdate() {
        Thread {
            try {
                val conn = URL("${BuildConfig.SITE}/app/version.json").openConnection() as HttpURLConnection
                conn.connectTimeout = 10_000
                conn.readTimeout = 10_000
                conn.useCaches = false
                if (conn.responseCode != 200) return@Thread
                val latest = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                if (latest.optInt("versionCode") <= BuildConfig.VERSION_CODE) return@Thread
                runOnUiThread {
                    AlertDialog.Builder(this)
                        .setTitle("새 버전이 있습니다")
                        .setMessage("${latest.optString("versionName")} 버전을 받아 설치해 주세요. (지금 버전 ${BuildConfig.VERSION_NAME})")
                        .setPositiveButton("받기") { _, _ -> openExternal(Uri.parse("${BuildConfig.SITE}/download/android")) }
                        .setNegativeButton("나중에", null)
                        .show()
                }
            } catch (_: Exception) {
                // 확인 못 해도 그대로 쓴다
            }
        }.start()
    }

    /** 화면(자바스크립트)에서 부르는 함수들. 화면 스레드가 아닌 곳에서 불린다. */
    inner class Bridge {
        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun prepare() = this@MainActivity.prepare()

        @JavascriptInterface
        fun start() {
            if (hasMic()) {
                startMic()
                return
            }
            runOnUiThread {
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            }
        }

        @JavascriptInterface
        fun stop() {
            worker.execute {
                engine.stop()
                emit(SpeechEngine.event("flushed"))
            }
        }

        @JavascriptInterface
        fun saveFile(name: String, mime: String, base64: String) = save(name, mime, Base64.decode(base64, Base64.DEFAULT))

        /** 진단: 최근 10초 소리 (base64, 16kHz 16비트 PCM) */
        @JavascriptInterface
        fun recentAudio(): String = Base64.encodeToString(engine.recentPcm(), Base64.NO_WRAP)
    }

    private companion object {
        const val REQ_MIC = 1
        const val REQ_STORAGE = 2
    }
}
