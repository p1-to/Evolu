/**
 * JPEGのEXIFから撮影日を読み取る
 * ファイルの更新日は保存や転送で変わるため、撮影日があればそちらを優先する
 */
(function (root) {
    const HEAD_BYTES = 256 * 1024; // EXIFはファイル先頭付近にある

    const TAG_DATE_TIME = 0x0132;
    const TAG_EXIF_IFD = 0x8769;
    const TAG_DATE_TIME_ORIGINAL = 0x9003;
    const TAG_DATE_TIME_DIGITIZED = 0x9004;

    function findEntry(view, tiff, ifdOffset, little, tag) {
        const ifd = tiff + ifdOffset;
        if (ifd + 2 > view.byteLength) return null;
        const count = view.getUint16(ifd, little);
        for (let i = 0; i < count; i++) {
            const entry = ifd + 2 + i * 12;
            if (entry + 12 > view.byteLength) return null;
            if (view.getUint16(entry, little) === tag) return entry;
        }
        return null;
    }

    function readDate(view, tiff, ifdOffset, little, tag) {
        const entry = findEntry(view, tiff, ifdOffset, little, tag);
        if (entry === null) return null;

        const length = view.getUint32(entry + 4, little);
        const start = tiff + view.getUint32(entry + 8, little);
        if (length < 10 || start + 10 > view.byteLength) return null;

        let text = '';
        for (let i = 0; i < 10; i++) text += String.fromCharCode(view.getUint8(start + i));

        const match = /^(\d{4}):(\d{2}):(\d{2})$/.exec(text);
        if (!match) return null;
        const [, y, m, d] = match;
        if (y === '0000' || m === '00' || d === '00' || Number(m) > 12 || Number(d) > 31) return null;
        return `${y}-${m}-${d}`;
    }

    function parseTiff(view, tiff) {
        if (tiff + 8 > view.byteLength) return null;
        const order = view.getUint16(tiff);
        if (order !== 0x4949 && order !== 0x4D4D) return null;
        const little = order === 0x4949;
        if (view.getUint16(tiff + 2, little) !== 42) return null;

        const ifd0 = view.getUint32(tiff + 4, little);
        const exifEntry = findEntry(view, tiff, ifd0, little, TAG_EXIF_IFD);
        if (exifEntry !== null) {
            const exifIfd = view.getUint32(exifEntry + 8, little);
            const date = readDate(view, tiff, exifIfd, little, TAG_DATE_TIME_ORIGINAL)
                || readDate(view, tiff, exifIfd, little, TAG_DATE_TIME_DIGITIZED);
            if (date) return date;
        }
        return readDate(view, tiff, ifd0, little, TAG_DATE_TIME);
    }

    /**
     * @param {ArrayBuffer} buffer JPEGの先頭部分
     * @returns {string|null} YYYY-MM-DD
     */
    function parseExifDate(buffer) {
        const view = new DataView(buffer);
        if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;

        let offset = 2;
        while (offset + 4 <= view.byteLength) {
            if (view.getUint8(offset) !== 0xFF) return null;
            const marker = view.getUint8(offset + 1);
            if (marker === 0xDA || marker === 0xD9) return null; // 画像データ本体に到達

            const size = view.getUint16(offset + 2);
            if (size < 2) return null;

            const isExif = marker === 0xE1
                && offset + 10 <= view.byteLength
                && view.getUint32(offset + 4) === 0x45786966 // "Exif"
                && view.getUint16(offset + 8) === 0;
            if (isExif) return parseTiff(view, offset + 10);

            offset += 2 + size;
        }
        return null;
    }

    /**
     * @param {Blob} file
     * @returns {Promise<string|null>} 読み取れないときは null
     */
    async function readExifDate(file) {
        try {
            return parseExifDate(await file.slice(0, HEAD_BYTES).arrayBuffer());
        } catch (error) {
            console.warn('EXIF read failed:', error);
            return null;
        }
    }

    root.EvoluExif = { parseExifDate, readExifDate };
})(typeof window !== 'undefined' ? window : globalThis);
