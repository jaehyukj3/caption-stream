package io.github.jaehyukj3.captionhost

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

/**
 * 음성인식 모델 받기·보관.
 * 웹 송출 '기기 안 인식'이 쓰는 것과 같은 모델 조각(사이트의 /stt-web/engine/)을 받아
 * 앱 저장 공간에 sense-voice.onnx · silero_vad.onnx · tokens.txt로 둔다. 처음 한 번만 받는다.
 *
 * 조각을 이어 붙인 묶음의 앞부분이 곧 sense-voice.onnx라서, 묶음을 다 받은 뒤
 * 뒤쪽 작은 파일 둘만 떼어 내고 잘라 쓰면 저장 공간을 두 배로 쓰지 않는다.
 * 받다가 끊기면 다음에 받은 조각 다음부터 이어 받는다.
 */
class ModelStore(context: Context, private val site: String) {
    class Model(val dir: File) {
        val asr get() = File(dir, "sense-voice.onnx").path
        val vad get() = File(dir, "silero_vad.onnx").path
        val tokens get() = File(dir, "tokens.txt").path
    }

    private class Part(val name: String, val size: Long)
    private class Entry(val name: String, val start: Long, val end: Long)

    private val root = File(context.filesDir, "model")
    private val engineUrl = "$site/stt-web/engine/"

    /** 받아 둔 모델 (없으면 null) */
    fun local(): Model? =
        root.listFiles()?.firstOrNull { File(it, DONE).exists() }?.let { Model(it) }

    /**
     * 사이트의 모델 버전을 확인해 필요하면 받는다. 사이트에 닿지 않으면 받아 둔 것을 쓴다.
     * onProgress(받은 바이트, 전체 바이트)
     */
    fun ensure(onProgress: (Long, Long) -> Unit): Model {
        val manifest = try {
            JSONObject(get(engineUrl + "manifest.json", 15_000).bufferedReader().use { it.readText() })
        } catch (e: Exception) {
            local()?.let { return it }
            throw IllegalStateException("모델 정보를 받지 못했습니다. 인터넷 연결을 확인해 주세요. (${e.message})")
        }
        val version = manifest.getString("version")
        val dir = File(root, version)
        if (File(dir, DONE).exists()) return Model(dir)

        val total = manifest.getLong("size")
        val parts = manifest.getJSONArray("parts").let { a ->
            (0 until a.length()).map { a.getJSONObject(it).let { p -> Part(p.getString("name"), p.getLong("size")) } }
        }
        val entries = manifest.optJSONArray("files")?.let { a ->
            (0 until a.length()).map { a.getJSONObject(it).let { f -> Entry(f.getString("name"), f.getLong("start"), f.getLong("end")) } }
        } ?: DEFAULT_FILES
        check(entries[0].name == "sense-voice.onnx" && entries[0].start == 0L && entries.last().end == total) { "모델 묶음 구성이 예상과 다릅니다" }

        // 다른 버전 보관분 정리
        root.listFiles()?.filter { it.name != version }?.forEach { it.deleteRecursively() }
        dir.mkdirs()
        val data = File(dir, "model.data")
        RandomAccessFile(data, "rw").use { out ->
            // 이어 받기: 온전히 받은 조각 다음부터
            var offset = 0L
            var startPart = 0
            while (startPart < parts.size && offset + parts[startPart].size <= out.length()) offset += parts[startPart++].size
            out.setLength(offset)
            out.seek(offset)
            onProgress(offset, total)
            val buf = ByteArray(256 * 1024)
            for (i in startPart until parts.size) {
                val part = parts[i]
                var got = 0L
                get(engineUrl + part.name, 30_000).use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        got += n
                        onProgress(offset + got, total)
                    }
                }
                if (got != part.size) {
                    out.setLength(offset)
                    throw IllegalStateException("모델 조각이 덜 받아졌습니다. 다시 시도해 주세요.")
                }
                offset += got
            }
            out.fd.sync()
        }

        // 뒤쪽 작은 파일들을 떼어 내고, 남은 앞부분을 sense-voice.onnx로
        RandomAccessFile(data, "rw").use { raf ->
            for (e in entries.drop(1)) {
                val bytes = ByteArray((e.end - e.start).toInt())
                raf.seek(e.start)
                raf.readFully(bytes)
                File(dir, e.name).writeBytes(bytes)
            }
            raf.setLength(entries[0].end)
        }
        check(data.renameTo(File(dir, entries[0].name))) { "모델 파일을 정리하지 못했습니다" }
        File(dir, DONE).writeText(version)
        return Model(dir)
    }

    private fun get(url: String, timeoutMs: Int) =
        (URL(url).openConnection() as HttpURLConnection).run {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            useCaches = false
            if (responseCode != 200) {
                disconnect()
                throw IllegalStateException("모델 다운로드 실패 ($responseCode)")
            }
            inputStream
        }

    private companion object {
        const val DONE = ".complete"

        /** 예전 사이트 파일(manifest에 files가 없던 때)을 위한 기본값: sherpa-onnx 1.12.30 웹 빌드 묶음 구성 */
        val DEFAULT_FILES = listOf(
            Entry("sense-voice.onnx", 0, 239233841),
            Entry("silero_vad.onnx", 239233841, 239877695),
            Entry("tokens.txt", 239877695, 240193589),
        )
    }
}
