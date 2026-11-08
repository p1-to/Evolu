/**
 * 記録のバックアップ（ZIP書き出し・読み込み）
 * 写真は圧縮済みなので無圧縮で格納する。ZIPのままパソコン等で開いて写真を取り出すこともできる。
 */
(function (root) {
    const MANIFEST_NAME = 'manifest.json';
    const MAX_ZIP_BYTES = 0xFFFFFFFF; // ZIP64は使わない
    const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const EXTENSIONS = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/heic': 'heic',
        'image/heif': 'heif',
        'image/avif': 'avif'
    };

    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function dosDateTime(dateString) {
        const [y, m, d] = (dateString || '1980-01-01').split('-').map(Number);
        return { time: 0, date: ((Math.max(y, 1980) - 1980) << 9) | (m << 5) | d };
    }

    function localHeader(name, crc, size, stamp) {
        const header = new DataView(new ArrayBuffer(30));
        header.setUint32(0, 0x04034B50, true);
        header.setUint16(4, 20, true);
        header.setUint16(6, 0x0800, true); // ファイル名はUTF-8
        header.setUint16(8, 0, true); // 無圧縮
        header.setUint16(10, stamp.time, true);
        header.setUint16(12, stamp.date, true);
        header.setUint32(14, crc, true);
        header.setUint32(18, size, true);
        header.setUint32(22, size, true);
        header.setUint16(26, name.length, true);
        return header.buffer;
    }

    function centralHeader(entry) {
        const header = new DataView(new ArrayBuffer(46));
        header.setUint32(0, 0x02014B50, true);
        header.setUint16(4, 20, true);
        header.setUint16(6, 20, true);
        header.setUint16(8, 0x0800, true);
        header.setUint16(12, entry.stamp.time, true);
        header.setUint16(14, entry.stamp.date, true);
        header.setUint32(16, entry.crc, true);
        header.setUint32(20, entry.size, true);
        header.setUint32(24, entry.size, true);
        header.setUint16(28, entry.name.length, true);
        header.setUint32(42, entry.offset, true);
        return header.buffer;
    }

    /**
     * @param {Array<{image: Blob, date: string, memo: string}>} records
     * @param {(done: number, total: number) => void} [onProgress]
     * @returns {Promise<Blob>}
     */
    async function createBackup(records, onProgress) {
        const parts = [];
        const central = [];
        const manifest = [];
        let offset = 0;

        const addEntry = (nameText, body, crc, dateString) => {
            const name = encoder.encode(nameText);
            const stamp = dosDateTime(dateString);
            const header = localHeader(name, crc, body.size, stamp);
            parts.push(header, name, body);
            central.push({ name, crc, size: body.size, stamp, offset });
            offset += header.byteLength + name.length + body.size;
            if (offset > MAX_ZIP_BYTES) throw new Error('バックアップが4GBを超えるため作成できません。');
        };

        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const type = record.image.type || 'image/jpeg';
            const extension = EXTENSIONS[type] || 'img';
            const file = `photos/${String(i + 1).padStart(5, '0')}_${record.date}.${extension}`;

            // CRC計算の間だけ読み込み、ZIP本体にはBlobの参照を渡すのでメモリに溜まらない
            const crc = crc32(new Uint8Array(await record.image.arrayBuffer()));
            addEntry(file, record.image, crc, record.date);
            manifest.push({ file, date: record.date, memo: record.memo || '', type });

            if (onProgress) onProgress(i + 1, records.length);
        }

        const manifestBytes = encoder.encode(JSON.stringify({ app: 'Evolu', version: 1, records: manifest }, null, 2));
        addEntry(MANIFEST_NAME, new Blob([manifestBytes]), crc32(manifestBytes));

        const centralStart = offset;
        let centralSize = 0;
        for (const entry of central) {
            const header = centralHeader(entry);
            parts.push(header, entry.name);
            centralSize += header.byteLength + entry.name.length;
        }
        if (central.length > 0xFFFF) throw new Error('写真の枚数が多すぎるためバックアップを作成できません。');

        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054B50, true);
        end.setUint16(8, central.length, true);
        end.setUint16(10, central.length, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, centralStart, true);
        parts.push(end.buffer);

        return new Blob(parts, { type: 'application/zip' });
    }

    function invalid() {
        return new Error('Evoluのバックアップファイルではありません。');
    }

    async function readEntries(file) {
        const tailSize = Math.min(file.size, 22 + 0xFFFF);
        if (tailSize < 22) throw invalid();
        const tailStart = file.size - tailSize;
        const tail = new DataView(await file.slice(tailStart).arrayBuffer());

        let endOffset = -1;
        for (let i = tail.byteLength - 22; i >= 0; i--) {
            if (tail.getUint32(i, true) === 0x06054B50) { endOffset = i; break; }
        }
        if (endOffset < 0) throw invalid();

        const count = tail.getUint16(endOffset + 10, true);
        const centralSize = tail.getUint32(endOffset + 12, true);
        const centralStart = tail.getUint32(endOffset + 16, true);
        if (centralStart + centralSize > file.size) throw invalid();

        const central = new DataView(await file.slice(centralStart, centralStart + centralSize).arrayBuffer());
        const entries = new Map();
        let position = 0;
        for (let i = 0; i < count; i++) {
            if (position + 46 > central.byteLength || central.getUint32(position, true) !== 0x02014B50) throw invalid();
            const method = central.getUint16(position + 10, true);
            const size = central.getUint32(position + 24, true);
            const nameLength = central.getUint16(position + 28, true);
            const extraLength = central.getUint16(position + 30, true);
            const commentLength = central.getUint16(position + 32, true);
            const offset = central.getUint32(position + 42, true);
            const nameBytes = new Uint8Array(central.buffer, position + 46, nameLength);
            entries.set(decoder.decode(nameBytes), { method, size, offset });
            position += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    }

    async function entryBlob(file, entry, type) {
        if (entry.method !== 0) throw invalid(); // Evoluが書き出すZIPは常に無圧縮
        const header = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
        if (header.byteLength < 30 || header.getUint32(0, true) !== 0x04034B50) throw invalid();
        const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        if (start + entry.size > file.size) throw invalid();
        return file.slice(start, start + entry.size, type);
    }

    /**
     * @param {Blob} file バックアップZIP
     * @returns {Promise<Array<{image: Blob, date: string, memo: string}>>}
     */
    async function readBackup(file) {
        const entries = await readEntries(file);
        const manifestEntry = entries.get(MANIFEST_NAME);
        if (!manifestEntry) throw invalid();

        let manifest;
        try {
            manifest = JSON.parse(await (await entryBlob(file, manifestEntry)).text());
        } catch (error) {
            throw invalid();
        }
        if (!manifest || manifest.app !== 'Evolu' || manifest.version !== 1 || !Array.isArray(manifest.records)) {
            throw invalid();
        }

        const records = [];
        for (const item of manifest.records) {
            const entry = item && entries.get(item.file);
            if (!entry || typeof item.date !== 'string' || !DATE_PATTERN.test(item.date)) throw invalid();
            const type = typeof item.type === 'string' && item.type.startsWith('image/') ? item.type : 'image/jpeg';
            records.push({
                image: await entryBlob(file, entry, type),
                date: item.date,
                memo: typeof item.memo === 'string' ? item.memo : ''
            });
        }
        return records;
    }

    root.EvoluBackup = { createBackup, readBackup };
})(typeof window !== 'undefined' ? window : globalThis);
