package io.github.jaehyukj3.captionhost

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * 폰 안 음성인식. 노트북 프로그램·웹 '기기 안 인식'과 같은 방식:
 * Silero VAD가 말하는 구간을 찾고 SenseVoice가 받아 적는다. 음성은 폰 밖으로 나가지 않는다.
 *
 * 브라우저보다 나은 점
 *  - 마이크: 안드로이드 음성인식용 입력(VOICE_RECOGNITION)을 16kHz로 바로 받는다 (통화용 잡음 제거·음량 조절 없음)
 *  - 속도: 폰 CPU 여러 코어로 인식한다 (브라우저 WebAssembly는 1코어)
 *
 * 결과는 emit으로 웹 화면에 보낸다: result / decode / rx / listening / micError / error
 */
class SpeechEngine(private val emit: (JSONObject) -> Unit) {
    private var recognizer: OfflineRecognizer? = null
    private var vad: Vad? = null
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    /** 최근 10초 동안 인식에 넣은 소리 (진단용, 음량 맞춤 뒤) */
    private val recent = ShortArray(SAMPLE_RATE * 10)
    private var recentPos = 0
    private var recentFilled = false

    val isLoaded get() = recognizer != null

    fun load(model: ModelStore.Model) {
        if (recognizer != null) return
        val threads = if (Runtime.getRuntime().availableProcessors() >= 6) 4 else 2
        recognizer = OfflineRecognizer(
            config = OfflineRecognizerConfig(
                featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
                modelConfig = OfflineModelConfig(
                    senseVoice = OfflineSenseVoiceModelConfig(model = model.asr, language = "ko", useInverseTextNormalization = true),
                    tokens = model.tokens,
                    numThreads = threads,
                    provider = "cpu",
                    debug = false,
                ),
            ),
        )
        vad = Vad(
            config = VadModelConfig(
                sileroVadModelConfig = SileroVadModelConfig(
                    model = model.vad,
                    // 휴대폰 마이크 소리는 말 사이에도 잡음이 깔려 0.5에서는 짧은 조각만 잡힌다 (웹 기기 안 인식과 같은 값)
                    threshold = 0.35f,
                    minSilenceDuration = 0.4f, // 0.4초 쉬면 문장 확정 (0.5와 정확도 같고 0.1초 빠름)
                    minSpeechDuration = 0.25f,
                    windowSize = VAD_WINDOW,
                    maxSpeechDuration = 12f, // 쉬지 않고 말해도 12초마다 끊어서 확정
                ),
                sampleRate = SAMPLE_RATE,
                numThreads = 1,
                provider = "cpu",
                debug = false,
            ),
        )
    }

    /** 마이크를 켜고 인식을 시작한다. 실패하면 이유(사용자 안내 문구)를 돌려준다. RECORD_AUDIO 권한이 있어야 한다. */
    @SuppressLint("MissingPermission")
    fun start(): String? {
        if (running) return null
        val vad = vad ?: return "음성인식 모델이 아직 준비되지 않았습니다."
        // 마이크 본래 속도(48kHz 등)로 받아 직접 걸러서 16kHz로 줄인다 (Downsampler 설명 참고). 안 되면 16kHz로.
        var opened: AudioRecord? = null
        var rate = 0
        for (r in intArrayOf(48000, 44100, SAMPLE_RATE)) {
            val minBuf = AudioRecord.getMinBufferSize(r, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (minBuf <= 0) continue
            val candidate = try {
                // 인식이 잠깐 밀려도 소리를 잃지 않도록 10초 분량 버퍼
                AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, r, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minBuf, r * 2 * 10))
            } catch (_: Exception) {
                continue
            }
            if (candidate.state == AudioRecord.STATE_INITIALIZED) {
                opened = candidate
                rate = r
                break
            }
            candidate.release()
        }
        val rec = opened ?: return "마이크를 열지 못했습니다. 마이크 권한을 확인해 주세요."
        rec.startRecording()
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            rec.release()
            return "다른 앱이 마이크를 쓰고 있어 켤 수 없습니다. 통화·녹음·음성 비서 앱을 닫고 다시 시도해 주세요."
        }
        record = rec
        session.reset(vad)
        running = true
        emit(event("rate").put("message", "마이크 ${rate}Hz${if (rate == SAMPLE_RATE) "" else " → 16000Hz"}"))
        thread = Thread({ loop(rec, rate, vad) }, "speech").apply { start() }
        return null
    }

    /** 마이크를 끄고, 말하던 문장까지 확정한다 */
    fun stop() {
        if (!running && thread == null) return
        running = false
        thread?.join()
        thread = null
        record?.run {
            try { stop() } catch (_: Exception) {}
            release()
        }
        record = null
        vad?.let { session.flush(it) }
    }

    private fun loop(rec: AudioRecord, rate: Int, vad: Vad) {
        val pcm = ShortArray(rate / 10) // 100ms
        val down = if (rate == SAMPLE_RATE) null else Downsampler(rate)
        val gain = AutoGain()
        var statSince = SystemClock.elapsedRealtime()
        var statSamples = 0
        var statPeak = 0f
        var statSpeech = 0
        try {
            while (running) {
                val n = rec.read(pcm, 0, pcm.size)
                if (n < 0) {
                    emit(event("micError").put("message", "마이크 소리를 읽지 못했습니다 (오류 $n). 다시 시작해 주세요."))
                    break
                }
                if (n == 0) continue
                val raw = FloatArray(n)
                for (i in 0 until n) {
                    raw[i] = pcm[i] / 32768f
                    val a = abs(raw[i])
                    if (a > statPeak) statPeak = a
                }
                val f = down?.process(raw) ?: raw
                if (f.isEmpty()) continue
                gain.apply(f)
                remember(f)
                session.accept(f, vad)
                statSamples += f.size
                if (session.speaking) statSpeech += f.size
                val now = SystemClock.elapsedRealtime()
                if (now - statSince >= 3000) {
                    emit(
                        event("rx")
                            .put("seconds", statSamples.toDouble() / SAMPLE_RATE)
                            .put("peak", statPeak.toDouble())
                            .put("speech", statSpeech.toDouble() / SAMPLE_RATE)
                            .put("gain", gain.gain.toDouble()),
                    )
                    statSince = now; statSamples = 0; statPeak = 0f; statSpeech = 0
                }
            }
        } catch (e: Throwable) {
            emit(event("error").put("message", "음성인식 오류: ${e.message ?: e}"))
        }
    }

    private fun remember(f: FloatArray) = synchronized(recent) {
        for (v in f) {
            recent[recentPos] = (v * 32767f).toInt().toShort()
            recentPos = (recentPos + 1) % recent.size
            if (recentPos == 0) recentFilled = true
        }
    }

    /** 최근 10초 소리 (16kHz 16비트, 리틀 엔디언). 마이크를 끈 뒤에도 마지막 것을 꺼낼 수 있다. */
    fun recentPcm(): ByteArray = synchronized(recent) {
        val n = if (recentFilled) recent.size else recentPos
        val out = java.nio.ByteBuffer.allocate(n * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val start = if (recentFilled) recentPos else 0
        for (i in 0 until n) out.putShort(recent[(start + i) % recent.size])
        out.array()
    }

    private fun transcribe(samples: FloatArray): String {
        val r = recognizer ?: return ""
        val t0 = SystemClock.elapsedRealtime()
        val stream = r.createStream()
        stream.acceptWaveform(samples, SAMPLE_RATE)
        r.decode(stream)
        val text = r.getResult(stream).text
        stream.release()
        emit(event("decode").put("ms", SystemClock.elapsedRealtime() - t0).put("audioMs", samples.size * 1000L / SAMPLE_RATE))
        return text.replace(Regex("\\s+"), " ").trim()
    }

    /** 노트북 프로그램(server/src/stt/sttWorker.ts)·웹(stt-web/worker.js)의 Session과 같은 동작 */
    private val session = object {
        var pending = FloatArray(0)
        val preroll = ArrayDeque<FloatArray>()
        var prerollLen = 0
        val speech = ArrayList<FloatArray>()
        var speechLen = 0
        var speaking = false
        var lastInterim = ""
        /** 이번 문장의 중간 결과들 (확정 다수결에 씀) */
        val interims = ArrayList<String>()
        var lastInterimAt = 0L
        var lastDecodeMs = 0L

        fun accept(samples: FloatArray, vad: Vad) {
            val buf = if (pending.isNotEmpty()) pending + samples else samples
            var o = 0
            while (o + VAD_WINDOW <= buf.size) {
                vad.acceptWaveform(buf.copyOfRange(o, o + VAD_WINDOW))
                o += VAD_WINDOW
            }
            pending = buf.copyOfRange(o, buf.size)

            val detected = vad.isSpeechDetected()
            if (detected && !speaking) {
                speech.clear(); speech.addAll(preroll)
                speechLen = prerollLen
            }
            if (detected) {
                speech.add(samples)
                speechLen += samples.size
            }
            speaking = detected
            remember(samples)

            drainFinals(vad)
            if (speaking) maybeInterim()
        }

        fun flush(vad: Vad) {
            vad.flush()
            val hadSegment = !vad.empty()
            drainFinals(vad)
            if (!hadSegment && speechLen > MIN_INTERIM_SAMPLES) emitFinal(transcribe(concat(speech)))
            reset(vad)
        }

        fun reset(vad: Vad) {
            vad.reset()
            resetSpeech()
            speaking = false
            pending = FloatArray(0)
            preroll.clear()
            prerollLen = 0
            lastInterim = ""
        }

        fun drainFinals(vad: Vad) {
            while (!vad.empty()) {
                val seg = vad.front()
                vad.pop()
                finalize(seg.samples)
                resetSpeech()
            }
        }

        fun maybeInterim() {
            val now = SystemClock.elapsedRealtime()
            val interval = max(MIN_INTERIM_INTERVAL_MS, lastDecodeMs * 2)
            if (speechLen < MIN_INTERIM_SAMPLES || now - lastInterimAt < interval) return
            val text = transcribe(concat(speech))
            lastDecodeMs = SystemClock.elapsedRealtime() - now
            lastInterimAt = SystemClock.elapsedRealtime()
            if (text.isNotEmpty() && text != lastInterim) {
                lastInterim = text
                interims.add(text)
                emit(event("result").put("kind", "interim").put("text", text))
            }
        }

        fun emitFinal(raw: String): String {
            val text = mergeFinal(lastInterim, raw)
            lastInterim = ""
            if (text.isNotEmpty()) emit(event("result").put("kind", "final").put("text", text))
            return text
        }

        /**
         * 문장 확정. 바로 확정해 보내고(기다리지 않게), 결과가 마지막 중간 결과와 다르면(맞게 보였다가 틀리게 바뀌는 경우)
         * 소리를 조금 달리 넣어 두 번 더 인식한 뒤 최근 중간 결과들까지 넣어 서로 가장 비슷한 결과(다수결)를 고른다.
         * 그 결과가 처음 확정한 것과 다르면 방금 줄을 고친다(revise).
         * (잡음·잔향을 섞은 낭독 48문장: 글자 오류 6.9% → 6.4%)
         */
        fun finalize(samples: FloatArray) {
            val first = transcribe(samples)
            val interim = lastInterim
            val sent = emitFinal(first)
            if (interim.isEmpty() || normText(first) == normText(interim) || sent.isEmpty()) return
            val pad = FloatArray(SAMPLE_RATE * 6 / 10)
            val cands = arrayListOf(first, transcribe(concat(listOf(pad, samples, pad))))
            cands.addAll(interims.takeLast(2))
            if (speechLen > 0) cands.add(transcribe(concat(speech)))
            val better = mergeFinal(interim, medoid(cands.filter { it.isNotEmpty() }))
            if (better.isNotEmpty() && better != sent) emit(event("result").put("kind", "revise").put("text", better))
        }

        fun resetSpeech() {
            interims.clear()
            speech.clear()
            speechLen = 0
            lastInterimAt = 0
        }

        fun remember(samples: FloatArray) {
            preroll.addLast(samples)
            prerollLen += samples.size
            while (prerollLen - preroll.first().size >= PREROLL_SAMPLES) prerollLen -= preroll.removeFirst().size
        }
    }

    /**
     * 입력 음량 자동 맞춤 (웹 마이크 처리와 같은 방식): 말소리 구간 크기를 기준으로 천천히 맞추고,
     * 조용할 때 잡음을 키우지 않도록 증폭은 최대 3배까지만.
     */
    private class AutoGain {
        var gain = 1f
        private var env = TARGET

        fun apply(f: FloatArray) {
            var o = 0
            while (o < f.size) {
                val end = min(f.size, o + BLOCK)
                var sum = 0f
                for (i in o until end) sum += f[i] * f[i]
                val rms = sqrt(sum / (end - o))
                if (rms > FLOOR) env = env * ENV_KEEP + rms * (1 - ENV_KEEP)
                val want = min(MAX_GAIN, max(MIN_GAIN, TARGET / env))
                gain += (want - gain) * GAIN_STEP
                for (i in o until end) f[i] = (f[i] * gain).coerceIn(-1f, 1f)
                o = end
            }
        }

        private companion object {
            const val BLOCK = 160 // 10ms
            const val TARGET = 0.08f
            const val FLOOR = 0.003f
            const val MIN_GAIN = 0.5f
            const val MAX_GAIN = 3f
            // 웹(48kHz, 128샘플마다 0.995 / 0.01)과 같은 빠르기를 10ms 단위로 환산
            val ENV_KEEP = 0.995f.pow(10f / 2.667f)
            val GAIN_STEP = 1 - 0.99f.pow(10f / 2.667f)
        }
    }

    companion object {
        const val SAMPLE_RATE = 16000
        private const val VAD_WINDOW = 512
        /** 말 시작 직전 소리도 포함 (첫 음절 잘림 방지) */
        private const val PREROLL_SAMPLES = SAMPLE_RATE * 3 / 10
        /** 이보다 짧은 말소리 구간은 중간 결과를 내지 않는다 */
        private const val MIN_INTERIM_SAMPLES = SAMPLE_RATE / 2
        private const val MIN_INTERIM_INTERVAL_MS = 700L

        fun event(op: String): JSONObject = JSONObject().put("op", op)

        /**
         * 확정 결과가 문장 앞부분을 빠뜨렸으면(예: 중간 "문을 닫습니다" → 확정 "닫습니다") 마지막 중간 결과의 앞부분으로 채운다.
         * SenseVoice는 같은 말소리라도 끝까지 넣고 다시 인식하면 앞 어절을 빼먹을 때가 있다 (잡음 많은 소리에서 잦음).
         * 확정 결과가 중간 결과의 뒷부분과 맞아떨어질 때만 채우고, 전혀 다른 문장이면 확정 결과를 그대로 쓴다.
         */
        fun mergeFinal(interim: String, final: String): String {
            val fi = normText(final)
            val it = normText(interim)
            if (it.isEmpty() || fi.length >= it.length * 0.8) return final
            if (fi.isEmpty()) return interim
            var best = -1
            var bestRatio = Double.MAX_VALUE
            for (p in 1 until interim.length) {
                if (interim[p - 1] != ' ') continue // 어절 경계에서만
                val a = normText(interim.substring(p))
                if (a.isEmpty()) continue
                var cost = Int.MAX_VALUE
                for (k in max(1, a.length - 2)..min(fi.length, a.length + 2)) cost = min(cost, editDistance(a, fi.substring(0, k)))
                val ratio = cost.toDouble() / a.length
                if (ratio <= 0.34 && ratio < bestRatio) {
                    best = p
                    bestRatio = ratio
                }
            }
            return if (best < 0) final else "${interim.substring(0, best).trim()} $final"
        }

        /** 다른 후보들과의 글자 차이 합이 가장 작은 후보 (같으면 앞의 것) */
        private fun medoid(cands: List<String>): String {
            if (cands.isEmpty()) return ""
            var best = cands[0]
            var bestD = Int.MAX_VALUE
            for (c in cands) {
                val d = cands.sumOf { editDistance(normText(c), normText(it)) }
                if (d < bestD) {
                    best = c
                    bestD = d
                }
            }
            return best
        }

        private val PUNCT = Regex("[\\s.,?!·…~\"'()]")
        private fun normText(s: String) = s.replace(PUNCT, "")

        private fun editDistance(a: String, b: String): Int {
            var prev = IntArray(b.length + 1) { it }
            for (i in 1..a.length) {
                val cur = IntArray(b.length + 1)
                cur[0] = i
                for (j in 1..b.length) cur[j] = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1)
                prev = cur
            }
            return prev[b.length]
        }

        private fun concat(parts: List<FloatArray>): FloatArray {
            val out = FloatArray(parts.sumOf { it.size })
            var o = 0
            for (p in parts) {
                p.copyInto(out, o)
                o += p.size
            }
            return out
        }
    }
}
