package io.github.jaehyukj3.captionhost

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import org.json.JSONObject

/**
 * 폰에 들어 있는 기기 안 음성인식(갤럭시·구글)을 빌려 쓰는 방식.
 * 안드로이드 12부터 '기기 안에서만 처리'를 지정할 수 있어(createOnDeviceSpeechRecognizer) 음성이 폰 밖으로 나가지 않는다.
 * 앱 안 모델(SenseVoice)보다 정확하다: 같은 강당 녹음에서 갤럭시 녹음 앱 변환이 훨씬 잘 받아 적었다.
 *
 * 폰 음성인식은 한 문장이 끝나면 스스로 멈추므로, 결과를 받을 때마다 곧바로 다시 듣기 시작해 강의 내내 이어 간다.
 * 결과는 SpeechEngine과 같은 형식으로 화면에 보낸다: result(interim/final) / listening / micError / error
 * SpeechRecognizer는 화면 스레드에서만 다룰 수 있어 모든 호출을 화면 스레드로 보낸다.
 */
@android.annotation.TargetApi(Build.VERSION_CODES.S)
class SystemSpeechEngine private constructor(private val context: Context, private val emit: (JSONObject) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var running = false
    private var announced = false
    private var lastPartial = ""
    /** 연달아 실패한 횟수 (다시 시작 간격을 늘리고, 너무 많으면 알린다) */
    private var failures = 0
    private var onStopped: (() -> Unit)? = null

    val isAvailable: Boolean
        get() = SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

    private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, LANGUAGE)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    }

    /** 한국어 기기 안 인식이 준비됐는지 확인한다. 언어팩이 없으면 받기를 요청한다. ready / error(where=prepare) */
    fun prepare() = main.post {
        if (!isAvailable) {
            emit(SpeechEngine.event("error").put("where", "prepare").put("message", "이 폰은 기기 안 음성인식을 지원하지 않습니다 (안드로이드 12 이상 필요)."))
            return@post
        }
        // 안드로이드 12는 언어팩 확인 기능이 없어 시작해 봐야 안다
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) checkKorean() else emit(SpeechEngine.event("ready"))
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.TIRAMISU)
    private fun checkKorean() {
        val probe = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        probe.checkRecognitionSupport(intent, context.mainExecutor, object : RecognitionSupportCallback {
            override fun onSupportResult(support: RecognitionSupport) {
                probe.destroy()
                val installed = support.installedOnDeviceLanguages.any { it.startsWith("ko") }
                val canDownload = (support.supportedOnDeviceLanguages + support.pendingOnDeviceLanguages).any { it.startsWith("ko") }
                when {
                    installed -> emit(SpeechEngine.event("ready"))
                    canDownload -> {
                        SpeechRecognizer.createOnDeviceSpeechRecognizer(context).apply {
                            triggerModelDownload(intent)
                            main.postDelayed({ destroy() }, 1000)
                        }
                        emit(
                            SpeechEngine.event("error").put("where", "prepare").put(
                                "message",
                                "폰에 한국어 기기 안 음성인식 언어팩이 없어 받기를 요청했습니다. 와이파이에서 몇 분 기다린 뒤 다시 시도해 주세요.",
                            ),
                        )
                    }
                    // 확인 결과가 비어 있는 폰도 있어, 그때는 일단 시작해 본다
                    else -> emit(SpeechEngine.event("ready"))
                }
            }

            override fun onError(error: Int) {
                probe.destroy()
                emit(SpeechEngine.event("ready"))
            }
        })
    }

    /** 듣기 시작. RECORD_AUDIO 권한이 있어야 한다. */
    fun start() = main.post {
        if (running) return@post
        if (!isAvailable) {
            emit(SpeechEngine.event("micError").put("message", "이 폰은 기기 안 음성인식을 지원하지 않습니다."))
            return@post
        }
        running = true
        announced = false
        failures = 0
        lastPartial = ""
        listen(recreate = true)
    }

    /** 멈추고, 말하던 문장까지 확정한 뒤 done을 부른다 */
    fun stop(done: () -> Unit) = main.post {
        if (!running) {
            done()
            return@post
        }
        running = false
        onStopped = done
        recognizer?.stopListening()
        // 결과가 오지 않는 폰을 위해 잠시 뒤 정리
        main.postDelayed({ finish() }, STOP_TIMEOUT_MS)
    }

    private fun listen(recreate: Boolean) {
        if (!running) return
        if (recreate || recognizer == null) {
            recognizer?.destroy()
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context).apply { setRecognitionListener(listener) }
        }
        recognizer?.startListening(intent)
    }

    private fun restart(recreate: Boolean) {
        val delay = if (failures == 0) 0L else minOf(2000L, 150L * failures)
        main.postDelayed({ listen(recreate) }, delay)
    }

    private fun finish() {
        val done = onStopped ?: return
        onStopped = null
        if (lastPartial.isNotBlank()) emitFinal(lastPartial)
        recognizer?.destroy()
        recognizer = null
        done()
    }

    private fun emitFinal(text: String) {
        lastPartial = ""
        val t = text.trim()
        if (t.isNotEmpty()) emit(SpeechEngine.event("result").put("kind", "final").put("text", t))
    }

    private fun firstResult(b: Bundle?) =
        b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            if (!announced) {
                announced = true
                emit(SpeechEngine.event("listening"))
            }
        }

        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            val text = firstResult(partialResults).trim()
            if (text.isEmpty() || text == lastPartial) return
            lastPartial = text
            emit(SpeechEngine.event("result").put("kind", "interim").put("text", text))
        }

        override fun onResults(results: Bundle?) {
            failures = 0
            emitFinal(firstResult(results).ifBlank { lastPartial })
            if (running) restart(recreate = false) else finish()
        }

        override fun onError(error: Int) {
            if (!running) {
                finish()
                return
            }
            when (error) {
                // 말이 없었거나 알아듣지 못함: 하던 말은 확정하고 계속 듣는다
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechRecognizer.ERROR_NO_MATCH -> {
                    if (lastPartial.isNotBlank()) emitFinal(lastPartial)
                    restart(recreate = false)
                }
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail("마이크 권한이 없습니다. 앱 권한에서 마이크를 허용해 주세요.")
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                    fail("폰에 한국어 기기 안 음성인식이 준비되지 않았습니다. 폰 설정에서 한국어 음성인식(오프라인) 언어팩을 받은 뒤 다시 시도해 주세요.")
                else -> {
                    // 바쁨, 연결 끊김 등: 잠시 뒤 새로 만들어 다시 듣는다
                    if (lastPartial.isNotBlank()) emitFinal(lastPartial)
                    failures++
                    if (failures >= MAX_FAILURES) fail("폰 음성인식이 계속 멈춥니다 (오류 $error). 다시 시작해 주세요.")
                    else restart(recreate = true)
                }
            }
        }
    }

    private fun fail(message: String) {
        running = false
        recognizer?.destroy()
        recognizer = null
        emit(SpeechEngine.event("micError").put("message", message))
    }

    companion object {
        private const val LANGUAGE = "ko-KR"
        private const val STOP_TIMEOUT_MS = 2500L
        private const val MAX_FAILURES = 15

        /** 안드로이드 12 미만에서는 기기 안 처리를 보장할 수 없어 쓰지 않는다 (null) */
        fun create(context: Context, emit: (JSONObject) -> Unit): SystemSpeechEngine? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) SystemSpeechEngine(context, emit) else null
    }
}
