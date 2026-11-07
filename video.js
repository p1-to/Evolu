/**
 * スライドショーの動画書き出し
 * すべて端末内で処理し、写真を外部へ送信しない。
 * WebCodecs + Mediabunny でMP4を作り、使えない環境では MediaRecorder（実時間で録画）に切り替える。
 */
(function (root) {
    const FPS = 30;
    const FADE_SECONDS = 0.3;
    const ENDING_SECONDS = 3;
    const FONT_FAMILY = '"Noto Sans JP", "Hiragino Sans", sans-serif';

    const FORMATS = {
        portrait: { width: 1080, height: 1920 },
        square: { width: 1080, height: 1080 },
        landscape: { width: 1920, height: 1080 }
    };

    function abortError() {
        return new DOMException('キャンセルされました', 'AbortError');
    }

    function daysBetween(fromDate, toDate) {
        return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86400000);
    }

    function loadImage(record) {
        return new Promise((resolve) => {
            const isBlob = typeof record.image !== 'string';
            const src = isBlob ? URL.createObjectURL(record.image) : record.image;
            const release = () => { if (isBlob) URL.revokeObjectURL(src); };
            const img = new Image();
            img.onload = () => resolve({ img, release });
            img.onerror = () => { release(); resolve(null); };
            img.src = src;
        });
    }

    function createLayer(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingQuality = 'high';
        return { canvas, ctx };
    }

    function drawContained(ctx, img, box) {
        const scale = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        const rect = { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
        ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
        return rect;
    }

    /** 枠に収めたときの表示面積（小さいほうの写真を基準にレイアウトを選ぶ） */
    function containedArea(img, box) {
        const scale = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight);
        return img.naturalWidth * img.naturalHeight * scale * scale;
    }

    function wrapText(ctx, text, maxWidth, maxLines) {
        const lines = [];
        for (const paragraph of text.split('\n')) {
            let line = '';
            for (const char of paragraph) {
                if (line && ctx.measureText(line + char).width > maxWidth) {
                    lines.push(line);
                    line = char;
                } else {
                    line += char;
                }
            }
            lines.push(line);
        }
        if (lines.length <= maxLines) return lines;
        const kept = lines.slice(0, maxLines);
        kept[maxLines - 1] = kept[maxLines - 1].slice(0, -1) + '…';
        return kept;
    }

    /** 画面の縦横に合わせた余白。縦動画はSNSのUIと重なる上下を避ける */
    function metrics(width, height) {
        const unit = Math.min(width, height) / 1080;
        const portrait = height > width;
        return {
            unit,
            top: (portrait ? 150 : 44) * unit,
            bottom: (portrait ? 260 : 56) * unit,
            side: 56 * unit
        };
    }

    function drawCaption(ctx, width, height, record, firstDate) {
        const m = metrics(width, height);
        const dateSize = 46 * m.unit;
        const memoSize = 36 * m.unit;
        const memoLineHeight = memoSize * 1.45;

        ctx.font = `400 ${memoSize}px ${FONT_FAMILY}`;
        const memoLines = record.memo ? wrapText(ctx, record.memo.trim(), width - m.side * 2, 3) : [];
        const textHeight = dateSize * 1.4 + memoLines.length * memoLineHeight;
        const textTop = height - m.bottom - textHeight;

        const gradientTop = textTop - 120 * m.unit;
        const gradient = ctx.createLinearGradient(0, gradientTop, 0, height);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(0.35, 'rgba(0,0,0,0.65)');
        gradient.addColorStop(1, 'rgba(0,0,0,0.85)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, gradientTop, width, height - gradientTop);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${dateSize}px ${FONT_FAMILY}`;
        const day = daysBetween(firstDate, record.date) + 1;
        ctx.fillText(`${record.date.replaceAll('-', '/')}　${day}日目`, m.side, textTop);

        ctx.fillStyle = '#e6e6e6';
        ctx.font = `400 ${memoSize}px ${FONT_FAMILY}`;
        memoLines.forEach((line, index) => {
            ctx.fillText(line, m.side, textTop + dateSize * 1.4 + index * memoLineHeight);
        });
    }

    function drawWatermark(ctx, width, height) {
        const m = metrics(width, height);
        ctx.save();
        ctx.font = `700 ${34 * m.unit}px "Inter", ${FONT_FAMILY}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 8 * m.unit;
        ctx.fillText('Evolu', width - m.side, m.top);
        ctx.restore();
    }

    function paintPhoto(layer, img, record, firstDate, options) {
        const { ctx, canvas } = layer;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawContained(ctx, img, { x: 0, y: 0, w: canvas.width, h: canvas.height });
        if (options.captions) drawCaption(ctx, canvas.width, canvas.height, record, firstDate);
        if (options.watermark) drawWatermark(ctx, canvas.width, canvas.height);
    }

    function drawEndingLabel(ctx, box, title, date, unit) {
        const padding = 24 * unit;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 10 * unit;
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${40 * unit}px "Inter", ${FONT_FAMILY}`;
        ctx.fillText(title, box.x + padding, box.y + box.h - padding - 44 * unit);
        ctx.font = `400 ${32 * unit}px ${FONT_FAMILY}`;
        ctx.fillText(date.replaceAll('-', '/'), box.x + padding, box.y + box.h - padding);
        ctx.shadowBlur = 0;
    }

    function paintEnding(layer, before, after, options) {
        const { ctx, canvas } = layer;
        const { width, height } = canvas;
        const m = metrics(width, height);
        const gap = 12 * m.unit;
        const portrait = height > width;
        const areaTop = portrait ? m.top : 0;
        const areaHeight = portrait ? height - m.top - m.bottom : height;

        // 横並びは写真の下に「○日間の変化」の帯を確保する
        const sideHeight = areaHeight - 120 * m.unit;
        const layouts = {
            stacked: [
                { x: 0, y: areaTop, w: width, h: (areaHeight - gap) / 2 },
                { x: 0, y: areaTop + (areaHeight + gap) / 2, w: width, h: (areaHeight - gap) / 2 }
            ],
            sideBySide: [
                { x: 0, y: areaTop, w: (width - gap) / 2, h: sideHeight },
                { x: (width + gap) / 2, y: areaTop, w: (width - gap) / 2, h: sideHeight }
            ]
        };
        const score = ([a, b]) => Math.min(containedArea(before.loaded.img, a), containedArea(after.loaded.img, b));
        const stacked = score(layouts.stacked) > score(layouts.sideBySide);
        const [first, second] = stacked ? layouts.stacked : layouts.sideBySide;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        const firstRect = drawContained(ctx, before.loaded.img, first);
        const secondRect = drawContained(ctx, after.loaded.img, second);
        drawEndingLabel(ctx, firstRect, 'BEFORE', before.record.date, m.unit);
        drawEndingLabel(ctx, secondRect, 'AFTER', after.record.date, m.unit);

        const days = daysBetween(before.record.date, after.record.date);
        if (days > 0) {
            const text = `${days}日間の変化`;
            ctx.font = `700 ${50 * m.unit}px ${FONT_FAMILY}`;
            const badgeWidth = ctx.measureText(text).width + 80 * m.unit;
            const badgeHeight = 96 * m.unit;
            // 写真の外（縦並びは境目、横並びは写真の下の余白）に置いて顔などに被せない
            const photosBottom = Math.max(firstRect.y + firstRect.h, secondRect.y + secondRect.h);
            const centerX = width / 2;
            const centerY = stacked
                ? first.y + first.h + gap / 2
                : photosBottom + 60 * m.unit;
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(centerX - badgeWidth / 2, centerY - badgeHeight / 2, badgeWidth, badgeHeight, badgeHeight / 2);
            } else {
                ctx.rect(centerX - badgeWidth / 2, centerY - badgeHeight / 2, badgeWidth, badgeHeight);
            }
            ctx.fill();
            ctx.fillStyle = '#a8e063';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, centerX, centerY);
        }
        if (options.watermark) drawWatermark(ctx, width, height);
    }

    /**
     * 全フレームを描画する。写真は下絵（レイヤー）に一度だけ描き、
     * 静止中は再描画しないので大きな写真でも重くならない。
     */
    async function drawTimeline(canvas, records, options, emit, onProgress, signal) {
        const ctx = canvas.getContext('2d', { alpha: false });
        const photoFrames = Math.max(1, Math.round(options.secondsPerPhoto * FPS));
        const endingFrames = Math.round(ENDING_SECONDS * FPS);
        const totalFrames = records.length * photoFrames + (options.ending && records.length > 1 ? endingFrames : 0);

        let current = createLayer(canvas.width, canvas.height);
        let previous = createLayer(canvas.width, canvas.height);
        let frameIndex = 0;
        let hasPrevious = false;

        const playLayer = async (frames) => {
            const fadeFrames = hasPrevious && frames >= 6
                ? Math.min(Math.round(FADE_SECONDS * FPS), Math.floor(frames / 3))
                : 0;
            for (let f = 0; f < frames; f++) {
                if (signal.aborted) throw abortError();
                if (f < fadeFrames) {
                    const alpha = (f + 1) / (fadeFrames + 1);
                    ctx.globalAlpha = 1;
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.globalAlpha = 1 - alpha;
                    ctx.drawImage(previous.canvas, 0, 0);
                    ctx.globalAlpha = alpha;
                    ctx.drawImage(current.canvas, 0, 0);
                    ctx.globalAlpha = 1;
                } else if (f === fadeFrames) {
                    ctx.drawImage(current.canvas, 0, 0);
                }
                await emit(frameIndex);
                frameIndex++;
                onProgress(Math.min(frameIndex / totalFrames, 1));
            }
            [current, previous] = [previous, current];
            hasPrevious = true;
        };

        const shown = [];
        let skipped = 0;
        const firstDate = records[0].date;

        for (const record of records) {
            if (signal.aborted) throw abortError();
            const loaded = await loadImage(record);
            if (!loaded) { skipped++; continue; }
            paintPhoto(current, loaded.img, record, firstDate, options);
            loaded.release();
            shown.push(record);
            await playLayer(photoFrames);
        }

        if (shown.length === 0) {
            throw new Error('写真を読み込めませんでした。この端末で表示できない形式の可能性があります。');
        }

        if (options.ending && shown.length > 1) {
            const before = { record: shown[0], loaded: await loadImage(shown[0]) };
            const after = { record: shown[shown.length - 1], loaded: await loadImage(shown[shown.length - 1]) };
            if (before.loaded && after.loaded) {
                paintEnding(current, before, after, options);
                await playLayer(endingFrames);
            }
            if (before.loaded) before.loaded.release();
            if (after.loaded) after.loaded.release();
        }

        return { skipped, frames: frameIndex };
    }

    async function encodeWithWebCodecs(canvas, runTimeline) {
        if (typeof VideoEncoder === 'undefined') return null;

        const mb = await import('./vendor/mediabunny.min.mjs');
        const codec = await mb.getFirstEncodableVideoCodec(['avc', 'hevc'], {
            width: canvas.width,
            height: canvas.height
        });
        if (!codec) return null;

        const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
        const source = new mb.CanvasSource(canvas, { codec, bitrate: mb.QUALITY_HIGH });
        output.addVideoTrack(source, { frameRate: FPS });
        await output.start();

        try {
            const result = await runTimeline((index) => source.add(index / FPS, 1 / FPS));
            source.close();
            await output.finalize();
            return {
                ...result,
                blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
                extension: 'mp4',
                encoder: `webcodecs:${codec}`
            };
        } catch (error) {
            await output.cancel().catch(() => {});
            throw error;
        }
    }

    function pickRecorderType() {
        const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
        return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || null;
    }

    async function encodeWithMediaRecorder(canvas, runTimeline) {
        if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) return null;
        const mimeType = pickRecorderType();
        if (!mimeType) return null;

        const stream = canvas.captureStream(FPS);
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000000 });
        const chunks = [];
        recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
        const stopped = new Promise((resolve, reject) => {
            recorder.onstop = resolve;
            recorder.onerror = (event) => reject(event.error || new Error('録画に失敗しました。'));
        });

        recorder.start(1000);
        const startedAt = performance.now();
        const waitUntil = async (seconds) => {
            const delay = startedAt + seconds * 1000 - performance.now();
            if (delay > 1) await new Promise((resolve) => setTimeout(resolve, delay));
        };

        try {
            const result = await runTimeline((index) => waitUntil(index / FPS));
            await waitUntil(result.frames / FPS);
            recorder.stop();
            await stopped;
            const type = mimeType.split(';')[0];
            return {
                ...result,
                blob: new Blob(chunks, { type }),
                extension: type === 'video/mp4' ? 'mp4' : 'webm',
                encoder: `mediarecorder:${mimeType}`
            };
        } catch (error) {
            if (recorder.state !== 'inactive') recorder.stop();
            throw error;
        } finally {
            stream.getTracks().forEach((track) => track.stop());
        }
    }

    /**
     * @param {Array} records 古い順の記録
     * @param {{format: string, secondsPerPhoto: number, captions: boolean, ending: boolean, watermark: boolean}} options
     * @param {{onProgress: (ratio: number) => void, signal: AbortSignal}} control
     * @returns {Promise<{blob: Blob, extension: string, encoder: string, skipped: number}>}
     */
    async function renderVideo(records, options, { onProgress, signal }) {
        if (records.length === 0) throw new Error('記録がありません。');
        const format = FORMATS[options.format] || FORMATS.portrait;

        if (document.fonts) {
            await Promise.allSettled([
                document.fonts.load(`700 40px "Noto Sans JP"`, '日本語'),
                document.fonts.load(`400 40px "Noto Sans JP"`, '日本語'),
                document.fonts.load(`700 40px "Inter"`, 'Evolu')
            ]);
        }

        const run = async (encode) => {
            const canvas = document.createElement('canvas');
            canvas.width = format.width;
            canvas.height = format.height;
            return encode(canvas, (emit) => drawTimeline(canvas, records, options, emit, onProgress, signal));
        };

        let primaryError = null;
        try {
            const result = await run(encodeWithWebCodecs);
            if (result) return result;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.warn('WebCodecs encode failed, falling back to MediaRecorder:', error);
            primaryError = error;
        }

        onProgress(0);
        const result = await run(encodeWithMediaRecorder);
        if (result) return result;
        throw primaryError || new Error('この端末のブラウザは動画の書き出しに対応していません。');
    }

    root.EvoluVideo = { renderVideo };
})(window);
