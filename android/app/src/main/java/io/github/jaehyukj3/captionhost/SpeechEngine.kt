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
 * 결과는 emit으로 웹 화면에 보낸다: result(interim/final) / decode / rx / listening / micError / error
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
                    maxSpeechDuration = 30f, // 줄은 session이 나누므로 VAD 구간 길이 제한은 넉넉하게 (버퍼 60초 안)
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

    /** 받아 적은 낱말. start/end는 세션 시작부터 센 초 */
    private class Word(var text: String, val start: Double, var end: Double) {
        val key get() = text.replace(PUNCT, "")
        val endsSentence get() = SENTENCE_END.containsMatchIn(text)
    }

    /** 소리를 받아 적어 낱말 단위로 돌려준다 (토큰 앞 공백이 낱말 시작, 문장부호는 앞 낱말에 붙임) */
    private fun transcribeWords(samples: FloatArray, offsetSec: Double): List<Word> {
        val r = recognizer ?: return emptyList()
        val t0 = SystemClock.elapsedRealtime()
        val stream = r.createStream()
        stream.acceptWaveform(samples, SAMPLE_RATE)
        r.decode(stream)
        val res = r.getResult(stream)
        stream.release()
        emit(event("decode").put("ms", SystemClock.elapsedRealtime() - t0).put("audioMs", samples.size * 1000L / SAMPLE_RATE))
        val out = ArrayList<Word>()
        val ts = res.timestamps
        res.tokens.forEachIndexed { i, t ->
            val at = offsetSec + (if (i < ts.size) ts[i].toDouble() else 0.0)
            val text = t.trim()
            if (text.isEmpty()) return@forEachIndexed
            val punct = ONLY_PUNCT.matches(text)
            val last = out.lastOrNull()
            if (last == null || (!punct && (t.startsWith(" ") || TRAILING_PUNCT.containsMatchIn(last.text)))) out.add(Word(text, at, at + 0.12))
            else {
                last.text += text
                last.end = at + 0.12
            }
        }
        return out
    }

    /**
     * 노트북 프로그램(server/src/stt/sttWorker.ts)·웹(stt-web/worker.js)의 Session과 같은 동작.
     * 연속 일치(local agreement)로 줄을 나누고 확정한다: 두 번 연달아 같게 나온 앞부분 낱말을 고정하고(다시 바뀌지 않음),
     * 고정된 낱말이 문장 끝이거나 40자를 넘거나 줄이 15초를 넘으면 그 줄을 확정한다.
     * 강당 녹음·낭독 시험(정답 대비): 정확도는 비슷하고, 글자가 더 바뀌지 않게 되기까지 2.7초 → 1.3초,
     * 확정할 때 이미 보이던 글자가 바뀌는 일 24번(3분) → 0번.
     */
    private val session = object {
        var pending = FloatArray(0)
        val preroll = ArrayDeque<FloatArray>()
        var prerollLen = 0
        /** 지금 줄의 소리와 그 시작 시각(초) */
        val line = ArrayList<FloatArray>()
        var lineLen = 0
        var lineStart = 0.0
        /** 지금까지 받은 소리 길이(초) */
        var clock = 0.0
        var speaking = false
        /** 고정된 낱말 (다시 바뀌지 않음) */
        val locked = ArrayList<Word>()
        /** 마지막으로 고정한 낱말: 다음 인식 결과에서 '고정한 부분 다음'을 찾는 기준 */
        var anchor: Word? = null
        /** 지난 인식에서 고정되지 않은 낱말 (이번 인식과 같으면 고정) */
        var prev: List<Word> = emptyList()
        var lastInterim = ""
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
            while (!vad.empty()) vad.pop() // 구간은 쓰지 않고 말하는 중인지만 본다

            val detected = vad.isSpeechDetected()
            if (detected && !speaking) {
                line.clear(); line.addAll(preroll)
                lineLen = prerollLen
                lineStart = clock - prerollLen.toDouble() / SAMPLE_RATE
                resetLocks()
            }
            if (detected || speaking) {
                line.add(samples)
                lineLen += samples.size
            }
            clock += samples.size.toDouble() / SAMPLE_RATE
            remember(samples)

            if (!detected && speaking) {
                speaking = false
                endLine()
                return
            }
            speaking = detected
            if (speaking) maybeInterim()
        }

        fun flush(vad: Vad) {
            if (lineLen > MIN_INTERIM_SAMPLES) endLine()
            reset(vad)
        }

        fun reset(vad: Vad) {
            vad.reset()
            line.clear()
            lineLen = 0
            resetLocks()
            speaking = false
            pending = FloatArray(0)
            preroll.clear()
            prerollLen = 0
        }

        fun maybeInterim() {
            val now = SystemClock.elapsedRealtime()
            val interval = max(MIN_INTERIM_INTERVAL_MS, lastDecodeMs * 2)
            if (lineLen < MIN_INTERIM_SAMPLES || now - lastInterimAt < interval) return
            val fresh = afterLocked(transcribeWords(concat(line), lineStart))
            lastDecodeMs = SystemClock.elapsedRealtime() - now
            lastInterimAt = SystemClock.elapsedRealtime()

            // 두 번 연달아 같은 앞부분, 그리고 1초 이상 지난 낱말만 고정
            var n = 0
            while (n < fresh.size && n < prev.size && fresh[n].key == prev[n].key && fresh[n].end < clock - LOCK_GUARD_SEC) n++
            for (i in 0 until n) lockWord(fresh[i])
            val rest = fresh.subList(n, fresh.size)
            // 화면에는 고정된 낱말 + 지난번 인식과도 같게 나온 뒷부분만 보인다 (이번에 처음 나온 낱말은 다음 인식에서 같으면 보임).
            // 새로 나온 끝 낱말은 다음 인식에서 자주 바뀌어, 보였다가 지워지는 일이 잦다 (강당 3분: 분당 62번 → 1번, 글자가 보이는 때는 약 0.5초 늦어짐)
            val prevRest = prev.drop(n)
            var agreed = 0
            while (agreed < rest.size && agreed < prevRest.size && rest[agreed].key == prevRest[agreed].key) agreed++
            prev = rest
            sendInterim(joinWords(locked + rest.subList(0, agreed)))

            // 줄 확정: 고정된 낱말이 문장 끝이면 거기서, 고정 글자가 많거나 줄이 너무 길면 지금까지
            val si = locked.indexOfFirst { it.endsSentence }
            if (si >= 0) {
                val carry = locked.subList(si + 1, locked.size).toList()
                finishLine(locked.subList(0, si + 1).toList(), carry.firstOrNull()?.start ?: rest.firstOrNull()?.start ?: clock)
                for (w in carry) lockWord(w)
            } else if (locked.sumOf { it.text.length } >= MAX_LINE_CHARS) {
                finishLine(locked.toList(), rest.firstOrNull()?.start ?: clock)
            } else if (lineLen.toDouble() / SAMPLE_RATE > MAX_LINE_SEC && rest.size > 1) {
                finishLine(locked + rest.subList(0, rest.size - 1), rest.last().start)
            }
        }

        /** 말이 끝났을 때: 고정되지 않은 뒷부분만 다시 받아 적어 붙여 확정 */
        fun endLine() {
            val tail = afterLocked(transcribeWords(concat(line), lineStart))
            emitFinal(joinWords(locked + tail))
            line.clear()
            lineLen = 0
            resetLocks()
        }

        /** 낱말들을 한 줄로 확정하고, cutSec 앞의 소리를 버려 다음 줄을 시작한다 */
        fun finishLine(words: List<Word>, cutSec: Double) {
            emitFinal(joinWords(words))
            val all = concat(line)
            val cut = Math.round((cutSec - 0.02 - lineStart) * SAMPLE_RATE).toInt().coerceIn(0, all.size)
            line.clear(); line.add(all.copyOfRange(cut, all.size))
            lineLen = all.size - cut
            lineStart += cut.toDouble() / SAMPLE_RATE
            resetLocks()
        }

        fun emitFinal(text: String) {
            if (text.isNotEmpty()) emit(event("result").put("kind", "final").put("text", text))
        }

        fun lockWord(w: Word) {
            locked.add(w)
            anchor = w
        }

        fun resetLocks() {
            locked.clear()
            anchor = null
            prev = emptyList()
            lastInterim = ""
            lastInterimAt = 0
        }

        /** 인식 결과에서 이미 고정한 부분 다음만 고른다: 마지막 고정 낱말을 글자로 찾고(±0.5초), 못 찾으면 시각으로 */
        fun afterLocked(ws: List<Word>): List<Word> {
            val a = anchor ?: return ws
            var best = -1
            var bestDt = Double.MAX_VALUE
            ws.forEachIndexed { i, w ->
                val dt = abs(w.start - a.start)
                if (w.key == a.key && dt < 0.5 && dt < bestDt) {
                    best = i
                    bestDt = dt
                }
            }
            if (best >= 0) return ws.subList(best + 1, ws.size)
            // 고정 낱말이 둘로 나뉘어 다시 나온 경우("다리를" → "다리" + "를")도 건너뜀
            return ws.filter { it.start > a.end - 0.05 }
        }

        fun sendInterim(text: String) {
            if (text.isEmpty() || text == lastInterim) return
            lastInterim = text
            emit(event("result").put("kind", "interim").put("text", text))
        }

        fun remember(samples: FloatArray) {
            preroll.addLast(samples)
            prerollLen += samples.size
            while (prerollLen - preroll.first().size >= PREROLL_SAMPLES) prerollLen -= preroll.removeFirst().size
        }
    }

    /**
     * 입력 음량 자동 맞춤 (웹 마이크 처리와 같은 방식): 말소리 구간 크기를 기준으로 천천히 맞추고,
     * 증폭은 최대 8배(노트북과 같음). 3배로는 3~4m 떨어진 발표자 목소리를 말소리로 잡지 못해 문장이 통째로 빠졌다.
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
            const val MAX_GAIN = 8f
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
        private const val MIN_INTERIM_INTERVAL_MS = 500L

        fun event(op: String): JSONObject = JSONObject().put("op", op)

        /** 이만큼 지난 낱말만 고정한다 (갓 들어온 끝부분은 다음 인식에서 자주 바뀐다) */
        private const val LOCK_GUARD_SEC = 1.0
        /** 고정된 글자가 이보다 많으면 줄을 확정한다 */
        private const val MAX_LINE_CHARS = 40
        /** 줄이 이보다 길면 마지막 낱말 앞에서 줄을 확정한다 */
        private const val MAX_LINE_SEC = 15.0

        private val PUNCT = Regex("[.,?!]")
        private val ONLY_PUNCT = Regex("^[.,?!]+$")
        private val TRAILING_PUNCT = Regex("[.,?!]$")
        private val SENTENCE_END = Regex("[.?!]$")
        private fun joinWords(ws: List<Word>) = ws.joinToString(" ") { it.text }

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
