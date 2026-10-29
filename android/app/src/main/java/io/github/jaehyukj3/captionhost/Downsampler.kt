package io.github.jaehyukj3.captionhost

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * 마이크 소리(48kHz 등)를 인식용 16kHz로 줄인다. 웹 마이크 처리(client/src/stt/micCapture.ts)와 같은 방식.
 *
 * 폰에 16kHz로 바로 달라고 하면 기기에 따라 걸러 내지 않고 솎아 내기만 해서, 8kHz 위 소리(ㅅ·ㅊ 같은 자음, 잡음)가
 * 아래로 접혀 들어와 자음이 뭉개진다 (실제 폰 녹음에서 7~8kHz가 3~6kHz보다 큼 → "닫으면"을 "받으면"으로).
 * 그래서 원래 속도로 받아 저역 통과 필터(차단 7.2kHz, Blackman 창 windowed-sinc)를 건 뒤,
 * 16kHz 출력 시각마다 앞뒤 값을 보간해 내보낸다 (44.1kHz처럼 나누어떨어지지 않아도 시각이 정확하다).
 */
class Downsampler(inputRate: Int, private val outputRate: Int = SpeechEngine.SAMPLE_RATE) {
    private val ratio = inputRate.toDouble() / outputRate
    private val kernel: FloatArray
    private val hist: FloatArray
    private var h = 0
    /** 다음 출력 시각(입력 샘플 단위)과 지금 입력 번호, 직전 필터 값 */
    private var t = 0.0
    private var i = 0L
    private var prevY = 0f

    init {
        val taps = (ratio * 21).roundToInt() or 1
        kernel = FloatArray(taps)
        val m = (taps - 1) / 2.0
        val fc = 7200.0 / inputRate
        var sum = 0.0
        for (k in 0 until taps) {
            val x = k - m
            val sinc = if (x == 0.0) 2 * fc else sin(2 * PI * fc * x) / (PI * x)
            val win = 0.42 - 0.5 * cos(2 * PI * k / (taps - 1)) + 0.08 * cos(4 * PI * k / (taps - 1))
            kernel[k] = (sinc * win).toFloat()
            sum += kernel[k]
        }
        for (k in 0 until taps) kernel[k] = (kernel[k] / sum).toFloat()
        hist = FloatArray(taps)
    }

    fun process(input: FloatArray, n: Int = input.size): FloatArray {
        val out = FloatArray((n / ratio).toInt() + 2)
        var o = 0
        val len = kernel.size
        for (s in 0 until n) {
            hist[h] = input[s]
            h = (h + 1) % len
            var y = 0f
            var idx = h
            for (j in 0 until len) {
                y += hist[idx] * kernel[j]
                idx = if (idx + 1 == len) 0 else idx + 1
            }
            while (t <= i) {
                val frac = (t - (i - 1)).toFloat()
                out[o++] = prevY + (y - prevY) * frac
                t += ratio
            }
            prevY = y
            i++
            // 오래 켜 두어도 소수점 오차가 쌓이지 않게 기준을 당겨 둔다
            if (i > 1_000_000) {
                i -= 1_000_000
                t -= 1_000_000.0
            }
        }
        return out.copyOf(o)
    }
}
