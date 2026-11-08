/**
 * Evolu - Growth Tracking App
 * @description IndexedDBを利用したクライアントサイド完結型のPWA
 */

// =================================================================
// 1. Application State (状態管理)
// =================================================================
let records = []; 
let currentIndex = 0; 
let slideInterval = null; 
let db = null; 

// =================================================================
// 2. Database Service (IndexedDB)
// 個人情報（写真）を扱うため、サーバー通信を行わずIndexedDBを採用
// =================================================================

/**
 * IndexedDBの初期化と接続
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('EvoluDB', 1);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('records')) {
                // 自動採番されるIDを主キーとして設定
                db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };

        request.onerror = (event) => {
            console.error('IndexedDB Initialization failed:', event.target.error);
            reject('データベース接続エラー');
        };
    });
}

function addRecordToDB(record) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['records'], 'readwrite');
        const store = transaction.objectStore('records');
        const request = store.add(record);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getAllRecordsFromDB() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['records'], 'readonly');
        const store = transaction.objectStore('records');
        const request = store.getAll();

        request.onsuccess = () => {
            let loadedData = request.result;
            // 古い日付順にソートして返却（ビフォーアフター比較のため）
            loadedData.sort(compareRecords);
            resolve(loadedData);
        };
        request.onerror = () => reject(request.error);
    });
}

function runStoreRequest(mode, createRequest) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['records'], mode);
        const request = createRequest(transaction.objectStore('records'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

/**
 * 旧形式（Base64文字列）の記録をBlobへ移行する。
 * Blobは表示するときだけ読み込まれるので、起動時に全写真をメモリへ載せずに済む。
 * 1件ずつ別トランザクションで保存し、途中で失敗しても元データは残して次回起動時に再試行する。
 */
async function migrateLegacyRecords(onProgress) {
    const FLAG = 'evolu-blob-migrated';
    try {
        if (localStorage.getItem(FLAG) === '1') return;
    } catch (error) { /* ストレージ不可の環境では毎回確認する */ }

    const keys = await runStoreRequest('readonly', (store) => store.getAllKeys());
    let failed = 0;

    for (let i = 0; i < keys.length; i++) {
        const record = await runStoreRequest('readonly', (store) => store.get(keys[i]));
        if (record && typeof record.image === 'string') {
            try {
                record.image = dataUrlToBlob(record.image);
                await runStoreRequest('readwrite', (store) => store.put(record));
            } catch (error) {
                failed++;
                console.warn('Record migration failed:', keys[i], error);
            }
            onProgress(i + 1, keys.length);
        }
    }

    if (failed === 0) {
        try { localStorage.setItem(FLAG, '1'); } catch (error) { /* 次回も確認するだけなので無視 */ }
    }
}

function deleteRecordFromDB(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['records'], 'readwrite');
        const store = transaction.objectStore('records');
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function clearAllRecordsInDB() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['records'], 'readwrite');
        const store = transaction.objectStore('records');
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// =================================================================
// 3. Utility Functions (汎用関数)
// =================================================================
function formatDate(dateObj) {
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/** 日付順。同じ日付は追加した順 */
function compareRecords(a, b) {
    return new Date(a.date) - new Date(b.date) || (a.id || 0) - (b.id || 0);
}

function dataUrlToBlob(dataUrl) {
    const match = /^data:([^;,]*)((?:;[^;,]*)*),/.exec(dataUrl);
    if (!match || !/;base64$/i.test(match[2])) throw new Error('Unsupported data URL');
    const binary = atob(dataUrl.slice(match[0].length));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: match[1] || 'image/jpeg' });
}

/**
 * ファイルを端末へ渡す。スマホは共有シート（写真アプリへの保存など）、
 * パソコンは通常のダウンロードを使う。共有シートはボタン操作の直後にしか開けない。
 */
async function saveFile(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    const isTouchDevice = navigator.maxTouchPoints > 0;

    if (isTouchDevice && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file] });
            return;
        } catch (error) {
            if (error.name === 'AbortError') return; // ユーザーが閉じただけ
            console.warn('Share failed, falling back to download:', error);
        }
    }

    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 端末の容量不足時にブラウザが記録を自動削除しないよう依頼する */
function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
    }
}

function putRecordToDB(record) {
    return runStoreRequest('readwrite', (store) => store.put(record));
}

/**
 * サムネイルだけを追記する。保存の直前にDBの最新の記録を読み直すので、
 * 作成中に日付やメモが編集されても上書きしない。
 */
function saveThumbnailToDB(id, thumb) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['records'], 'readwrite');
        const store = transaction.objectStore('records');
        const request = store.get(id);
        request.onsuccess = () => {
            if (request.result) store.put({ ...request.result, thumb });
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

/** 2つの日付（YYYY-MM-DD）の差を日数で返す */
function daysBetween(fromDate, toDate) {
    return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86400000);
}

function isTypingTarget(element) {
    return element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
}

const ICON_PLAY = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

// =================================================================
// 4. Thumbnails (サムネイル)
// 一覧用の小さな画像を一度だけ作り、記録と一緒に保存しておく。
// 元の写真を一覧で何枚も読み込むと、スマホではメモリが足りなくなるため。
// =================================================================
const THUMB_SIZE = 160;
const thumbUrls = new Map(); // record.id -> object URL
const thumbJobs = new Map(); // record.id -> Promise
let thumbQueue = Promise.resolve();

function loadImageElement(source) {
    return new Promise((resolve) => {
        const isBlob = typeof source !== 'string';
        const src = isBlob ? URL.createObjectURL(source) : source;
        const img = new Image();
        img.onload = () => { if (isBlob) URL.revokeObjectURL(src); resolve(img); };
        img.onerror = () => { if (isBlob) URL.revokeObjectURL(src); resolve(null); };
        img.src = src;
    });
}

async function createThumbnail(source) {
    const img = await loadImageElement(source);
    if (!img) return null;
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const ctx = canvas.getContext('2d');
    const scale = Math.max(THUMB_SIZE / img.naturalWidth, THUMB_SIZE / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (THUMB_SIZE - w) / 2, (THUMB_SIZE - h) / 2, w, h);
    img.src = '';
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

/** サムネイルのURLを返す。未作成なら順番に作る（同時に大量の写真をデコードしない） */
function getThumbnailUrl(record) {
    if (thumbUrls.has(record.id)) return Promise.resolve(thumbUrls.get(record.id));
    if (thumbJobs.has(record.id)) return thumbJobs.get(record.id);

    const job = thumbQueue.then(async () => {
        let thumb = record.thumb;
        if (!thumb) {
            thumb = await createThumbnail(record.image);
            if (!thumb) return null;
            record.thumb = thumb;
            saveThumbnailToDB(record.id, thumb).catch((error) => console.warn('Thumbnail save failed:', error));
        }
        const url = URL.createObjectURL(thumb);
        thumbUrls.set(record.id, url);
        return url;
    }).catch((error) => {
        console.warn('Thumbnail failed:', error);
        return null;
    }).finally(() => thumbJobs.delete(record.id));

    thumbQueue = job;
    thumbJobs.set(record.id, job);
    return job;
}

function releaseThumbnail(id) {
    const url = thumbUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    thumbUrls.delete(id);
}

// =================================================================
// 5. Main Initialization & UI Controllers (初期化・UI制御)
// =================================================================
window.onload = async function() {

    const $ = (id) => document.getElementById(id);
    const DOM = {
        emptyState: $('emptyState'),
        viewerSection: $('viewerSection'),
        sampleBanner: $('sampleBanner'),
        stage: $('stage'),
        mainImage: $('mainImage'),
        counter: $('counter'),
        recordDate: $('recordDate'),
        recordDay: $('recordDay'),
        recordMemo: $('recordMemo'),
        editButton: $('editButton'),
        prevButton: $('prevButton'),
        nextButton: $('nextButton'),
        playPauseButton: $('playPauseButton'),
        timeInput: $('timeInput'),
        thumbStrip: $('thumbStrip'),
        exitFullscreenBtn: $('exitFullscreenBtn'),
        imageInput: $('imageInput'),
        addDialog: $('addDialog'),
        addPreview: $('addPreview'),
        recordForm: $('recordForm'),
        dateGroup: $('dateGroup'),
        multiDateNote: $('multiDateNote'),
        dateInput: $('dateInput'),
        memoInput: $('memoInput'),
        addSaveButton: $('addSaveButton'),
        addCancelButton: $('addCancelButton'),
        editDialog: $('editDialog'),
        editForm: $('editForm'),
        editDateInput: $('editDateInput'),
        editMemoInput: $('editMemoInput'),
        editCancelButton: $('editCancelButton'),
        deleteButton: $('deleteButton'),
        menuButton: $('menuButton'),
        menuDialog: $('menuDialog'),
        menuCloseButton: $('menuCloseButton'),
        menuSampleButton: $('menuSampleButton'),
        sampleButton: $('sampleButton'),
        removeSampleButton: $('removeSampleButton'),
        deleteAllButton: $('deleteAllButton'),
        backupButton: $('backupButton'),
        restoreButton: $('restoreButton'),
        restoreInput: $('restoreInput'),
        createVideoButton: $('createVideoButton'),
        videoDialog: $('videoDialog'),
        videoOptionsView: $('videoOptionsView'),
        videoProgressView: $('videoProgressView'),
        videoResultView: $('videoResultView'),
        videoFormat: $('videoFormat'),
        videoSeconds: $('videoSeconds'),
        videoCaptions: $('videoCaptions'),
        videoEnding: $('videoEnding'),
        videoWatermark: $('videoWatermark'),
        videoSummary: $('videoSummary'),
        videoStartButton: $('videoStartButton'),
        videoCloseButton: $('videoCloseButton'),
        videoCancelButton: $('videoCancelButton'),
        videoProgressBar: $('videoProgressBar'),
        videoProgressText: $('videoProgressText'),
        videoPreview: $('videoPreview'),
        videoResultNote: $('videoResultNote'),
        videoSaveButton: $('videoSaveButton'),
        videoRetryButton: $('videoRetryButton'),
        videoDoneButton: $('videoDoneButton')
    };

    let displayedUrl = null;

    // -----------------------------------------------------------------
    // 表示
    // -----------------------------------------------------------------

    /** 記録の追加・削除・並び替えのあとに呼ぶ */
    function renderAll() {
        const hasRecords = records.length > 0;
        DOM.emptyState.hidden = hasRecords;
        DOM.viewerSection.hidden = !hasRecords;
        DOM.sampleBanner.hidden = !records.some((record) => record.sample);
        DOM.menuSampleButton.hidden = records.some((record) => record.sample);
        if (!hasRecords) {
            stopSlideshow();
            exitFullscreen();
        }
        renderStrip();
        updateDisplay();
    }

    /** 今の1枚の表示を更新する */
    function updateDisplay() {
        const previousUrl = displayedUrl;
        displayedUrl = null;

        if (records.length === 0) {
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            DOM.mainImage.removeAttribute('src');
            return;
        }

        if (currentIndex >= records.length) currentIndex = records.length - 1;
        if (currentIndex < 0) currentIndex = 0;

        const record = records[currentIndex];
        if (typeof record.image === 'string') {
            DOM.mainImage.src = record.image; // 移行できなかった旧形式
        } else {
            displayedUrl = URL.createObjectURL(record.image);
            DOM.mainImage.src = displayedUrl;
        }
        if (previousUrl) URL.revokeObjectURL(previousUrl);

        DOM.mainImage.alt = `${record.date} の記録`;
        DOM.counter.textContent = `${currentIndex + 1} / ${records.length}`;
        DOM.recordDate.textContent = record.date.replaceAll('-', '/');
        DOM.recordDay.textContent = `${daysBetween(records[0].date, record.date) + 1}日目`;
        DOM.recordMemo.textContent = record.memo || '';

        const single = records.length < 2;
        DOM.prevButton.disabled = single;
        DOM.nextButton.disabled = single;
        DOM.playPauseButton.disabled = single;

        markActiveThumb();
    }

    const thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            thumbObserver.unobserve(entry.target);
            const record = records.find((r) => String(r.id) === entry.target.dataset.id);
            if (!record) continue;
            getThumbnailUrl(record).then((url) => {
                const img = entry.target.querySelector('img');
                if (url && img) img.src = url;
            });
        }
    }, { root: DOM.thumbStrip, rootMargin: '0px 200px' });

    function renderStrip() {
        thumbObserver.disconnect();
        const buttons = records.map((record, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'thumb';
            button.dataset.index = String(index);
            button.dataset.id = String(record.id);
            button.setAttribute('aria-label', `${record.date} の記録を表示`);
            const img = document.createElement('img');
            img.alt = '';
            const url = thumbUrls.get(record.id);
            if (url) img.src = url;
            button.append(img);
            if (!url) thumbObserver.observe(button);
            return button;
        });
        DOM.thumbStrip.replaceChildren(...buttons);
    }

    function markActiveThumb() {
        let active = null;
        for (const button of DOM.thumbStrip.children) {
            const isActive = Number(button.dataset.index) === currentIndex;
            button.classList.toggle('is-active', isActive);
            if (isActive) {
                button.setAttribute('aria-current', 'true');
                active = button;
            } else {
                button.removeAttribute('aria-current');
            }
        }
        // ページ全体は動かさず、一覧の横スクロールだけで今の1枚を中央に寄せる
        if (active) {
            DOM.thumbStrip.scrollLeft = active.offsetLeft - DOM.thumbStrip.clientWidth / 2 + active.clientWidth / 2;
        }
    }

    function showAt(index) {
        if (records.length === 0) return;
        currentIndex = (index + records.length) % records.length;
        updateDisplay();
    }

    // -----------------------------------------------------------------
    // スライドショー
    // -----------------------------------------------------------------
    function stopSlideshow() {
        if (slideInterval === null) return;
        clearInterval(slideInterval);
        slideInterval = null;
        DOM.playPauseButton.innerHTML = ICON_PLAY;
        DOM.playPauseButton.classList.remove('is-playing');
        DOM.playPauseButton.setAttribute('aria-label', 'スライドショーを再生');
    }

    function startSlideshow() {
        if (records.length <= 1) return;
        stopSlideshow();
        const intervalTime = parseFloat(DOM.timeInput.value) * 1000;
        DOM.playPauseButton.innerHTML = ICON_PAUSE;
        DOM.playPauseButton.classList.add('is-playing');
        DOM.playPauseButton.setAttribute('aria-label', 'スライドショーを一時停止');
        slideInterval = setInterval(() => showAt(currentIndex + 1), intervalTime);
    }

    DOM.playPauseButton.addEventListener('click', () => {
        slideInterval === null ? startSlideshow() : stopSlideshow();
    });
    DOM.timeInput.addEventListener('change', () => {
        if (slideInterval !== null) startSlideshow(); // 再生中なら新しい速度で続ける
    });
    DOM.prevButton.addEventListener('click', () => { stopSlideshow(); showAt(currentIndex - 1); });
    DOM.nextButton.addEventListener('click', () => { stopSlideshow(); showAt(currentIndex + 1); });
    DOM.thumbStrip.addEventListener('click', (event) => {
        const button = event.target.closest('.thumb');
        if (!button) return;
        stopSlideshow();
        showAt(Number(button.dataset.index));
    });

    // -----------------------------------------------------------------
    // 全画面とスワイプ
    // -----------------------------------------------------------------
    let hideButtonTimer = null;

    function showButtonTemporarily() {
        DOM.exitFullscreenBtn.classList.remove('hidden');
        if (hideButtonTimer) clearTimeout(hideButtonTimer);
        hideButtonTimer = setTimeout(() => DOM.exitFullscreenBtn.classList.add('hidden'), 3000);
    }

    function isFullscreen() {
        return document.body.classList.contains('fullscreen-mode');
    }

    function enterFullscreen() {
        if (records.length === 0) return;
        document.body.classList.add('fullscreen-mode');
        DOM.stage.setAttribute('aria-label', '写真');
        showButtonTemporarily();
    }

    function exitFullscreen() {
        document.body.classList.remove('fullscreen-mode');
        DOM.stage.setAttribute('aria-label', '全画面で表示');
        if (hideButtonTimer) clearTimeout(hideButtonTimer);
    }

    let touchStart = null;
    let lastSwipeAt = 0;
    DOM.stage.addEventListener('touchstart', (event) => {
        const touch = event.touches[0];
        touchStart = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });
    DOM.stage.addEventListener('touchend', (event) => {
        if (!touchStart) return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - touchStart.x;
        const dy = touch.clientY - touchStart.y;
        touchStart = null;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            lastSwipeAt = Date.now();
            stopSlideshow();
            showAt(currentIndex + (dx < 0 ? 1 : -1));
        }
    });

    DOM.stage.addEventListener('click', () => {
        if (Date.now() - lastSwipeAt < 400) return; // スワイプ直後に発生するクリックは無視する
        isFullscreen() ? showButtonTemporarily() : enterFullscreen();
    });
    DOM.stage.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !isFullscreen()) {
            event.preventDefault();
            enterFullscreen();
        }
    });
    DOM.exitFullscreenBtn.addEventListener('click', exitFullscreen);

    document.addEventListener('keydown', (event) => {
        if (document.querySelector('dialog[open]') || isTypingTarget(event.target) || records.length === 0) return;
        if (isFullscreen()) showButtonTemporarily();
        switch (event.key) {
            case 'ArrowRight':
                stopSlideshow();
                showAt(currentIndex + 1);
                break;
            case 'ArrowLeft':
                stopSlideshow();
                showAt(currentIndex - 1);
                break;
            case 'Escape':
                exitFullscreen();
                break;
        }
    });

    // -----------------------------------------------------------------
    // 写真の追加
    // -----------------------------------------------------------------
    let previewUrls = [];

    function clearAddPreview() {
        previewUrls.forEach((url) => URL.revokeObjectURL(url));
        previewUrls = [];
        DOM.addPreview.replaceChildren();
    }

    /** 撮影日（EXIF）→ ファイル更新日 → 今日 の順で日付を決める */
    async function detectPhotoDate(file) {
        const exifDate = await EvoluExif.readExifDate(file);
        if (exifDate) return exifDate;
        return formatDate(file.lastModified ? new Date(file.lastModified) : new Date());
    }

    document.querySelectorAll('.add-photo-button').forEach((button) => {
        button.addEventListener('click', () => {
            stopSlideshow();
            DOM.imageInput.click();
        });
    });

    DOM.imageInput.addEventListener('change', async () => {
        const files = Array.from(DOM.imageInput.files);
        if (files.length === 0) return;

        clearAddPreview();
        const shown = files.slice(0, 5);
        for (const file of shown) {
            const img = document.createElement('img');
            img.alt = '';
            const url = URL.createObjectURL(file);
            previewUrls.push(url);
            img.src = url;
            DOM.addPreview.append(img);
        }
        if (files.length > shown.length) {
            const more = document.createElement('div');
            more.className = 'more';
            more.textContent = `+${files.length - shown.length}`;
            DOM.addPreview.append(more);
        }

        const multiple = files.length > 1;
        DOM.dateGroup.hidden = multiple;
        DOM.dateInput.required = !multiple;
        DOM.multiDateNote.hidden = !multiple;
        DOM.addSaveButton.textContent = multiple ? `${files.length}枚を保存` : '保存する';
        DOM.memoInput.value = '';
        DOM.dateInput.value = multiple ? '' : await detectPhotoDate(files[0]);
        DOM.addDialog.showModal();
    });

    function resetAddForm() {
        DOM.imageInput.value = '';
        clearAddPreview();
    }

    function closeAddDialog() {
        DOM.addDialog.close();
        resetAddForm();
    }

    DOM.addCancelButton.addEventListener('click', closeAddDialog);
    // Escキーで閉じた場合。close イベントは遅れて届くことがあるので、開き直していたら何もしない
    DOM.addDialog.addEventListener('close', () => {
        if (!DOM.addDialog.open) resetAddForm();
    });

    DOM.recordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const files = Array.from(DOM.imageInput.files);
        if (files.length === 0) return;

        const memo = DOM.memoInput.value;
        const manualDate = DOM.dateInput.value;
        const saveText = DOM.addSaveButton.textContent;
        DOM.addSaveButton.textContent = '保存中...';
        DOM.addSaveButton.disabled = true;

        try {
            // 1枚ならフォームの日付（手で直せる）、複数なら写真ごとの撮影日を使う
            let lastAdded = null;
            for (const file of files) {
                const date = files.length > 1 ? await detectPhotoDate(file) : manualDate;
                const record = { image: file, date, memo };
                record.id = await addRecordToDB(record);
                records.push(record);
                lastAdded = record;
            }
            records.sort(compareRecords);
            currentIndex = records.indexOf(lastAdded);
            renderAll();
            requestPersistentStorage();
            closeAddDialog();
        } catch (error) {
            console.error('Data Save Error:', error);
            alert('保存に失敗しました: ' + error);
        } finally {
            DOM.addSaveButton.textContent = saveText;
            DOM.addSaveButton.disabled = false;
        }
    });

    // -----------------------------------------------------------------
    // 記録の編集・削除
    // -----------------------------------------------------------------
    DOM.editButton.addEventListener('click', () => {
        if (records.length === 0) return;
        stopSlideshow();
        const record = records[currentIndex];
        DOM.editDateInput.value = record.date;
        DOM.editMemoInput.value = record.memo || '';
        DOM.editDialog.showModal();
    });

    DOM.editCancelButton.addEventListener('click', () => DOM.editDialog.close());

    DOM.editForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const record = records[currentIndex];
        const updated = { ...record, date: DOM.editDateInput.value, memo: DOM.editMemoInput.value };
        try {
            await putRecordToDB(updated);
            records[currentIndex] = updated;
            records.sort(compareRecords);
            currentIndex = records.indexOf(updated);
            renderAll();
            DOM.editDialog.close();
        } catch (error) {
            console.error('Edit Error:', error);
            alert('保存に失敗しました: ' + error);
        }
    });

    DOM.deleteButton.addEventListener('click', async () => {
        const record = records[currentIndex];
        if (!confirm(`${record.date} の記録を削除しますか？\nこの操作は取り消せません。`)) return;
        try {
            await deleteRecordFromDB(record.id);
            releaseThumbnail(record.id);
            records.splice(currentIndex, 1);
            if (records.length <= 1) stopSlideshow();
            DOM.editDialog.close();
            renderAll();
        } catch (error) {
            alert('削除に失敗しました: ' + error);
        }
    });

    // -----------------------------------------------------------------
    // サンプル
    // -----------------------------------------------------------------
    async function addSamples(button) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = '準備中…';
        try {
            const samples = await EvoluSample.createSampleRecords();
            for (const sample of samples) {
                sample.id = await addRecordToDB(sample);
                records.push(sample);
            }
            records.sort(compareRecords);
            currentIndex = records.indexOf(samples[samples.length - 1]);
            renderAll();
        } catch (error) {
            console.error('Sample Error:', error);
            alert('サンプルを作成できませんでした: ' + error);
        } finally {
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    DOM.sampleButton.addEventListener('click', () => addSamples(DOM.sampleButton));
    DOM.menuSampleButton.addEventListener('click', async () => {
        DOM.menuDialog.close();
        await addSamples(DOM.menuSampleButton);
    });

    DOM.removeSampleButton.addEventListener('click', async () => {
        const samples = records.filter((record) => record.sample);
        try {
            for (const sample of samples) {
                await deleteRecordFromDB(sample.id);
                releaseThumbnail(sample.id);
            }
            records = records.filter((record) => !record.sample);
            currentIndex = records.length - 1;
            renderAll();
        } catch (error) {
            alert('サンプルを消せませんでした: ' + error);
        }
    });

    // -----------------------------------------------------------------
    // メニュー（データ管理）
    // -----------------------------------------------------------------
    DOM.menuButton.addEventListener('click', () => {
        stopSlideshow();
        DOM.menuDialog.showModal();
    });
    DOM.menuCloseButton.addEventListener('click', () => DOM.menuDialog.close());

    DOM.deleteAllButton.addEventListener('click', async () => {
        if (records.length === 0) {
            alert('削除する記録はありません。');
            return;
        }
        if (!confirm(`すべての記録（${records.length}件）を削除しますか？\nこの操作は取り消せません。`)) return;
        try {
            await clearAllRecordsInDB();
            records.forEach((record) => releaseThumbnail(record.id));
            records = [];
            currentIndex = 0;
            DOM.menuDialog.close();
            renderAll();
        } catch (error) {
            alert('全削除に失敗しました: ' + error);
        }
    });

    DOM.backupButton.addEventListener('click', async () => {
        const ownRecords = records.filter((record) => !record.sample);
        if (ownRecords.length === 0) {
            alert('バックアップする記録がありません。');
            return;
        }
        const originalText = DOM.backupButton.textContent;
        DOM.backupButton.disabled = true;
        try {
            const blobRecords = ownRecords.map((record) => (
                typeof record.image === 'string' ? { ...record, image: dataUrlToBlob(record.image) } : record
            ));
            const zip = await EvoluBackup.createBackup(blobRecords, (done, total) => {
                DOM.backupButton.textContent = `作成中… ${done} / ${total}`;
            });
            await saveFile(zip, `evolu-backup-${formatDate(new Date())}.zip`);
        } catch (error) {
            console.error('Backup Error:', error);
            alert('バックアップに失敗しました: ' + error.message);
        } finally {
            DOM.backupButton.textContent = originalText;
            DOM.backupButton.disabled = false;
        }
    });

    DOM.restoreButton.addEventListener('click', () => DOM.restoreInput.click());

    DOM.restoreInput.addEventListener('change', async () => {
        const file = DOM.restoreInput.files[0];
        DOM.restoreInput.value = '';
        if (!file) return;

        const originalText = DOM.restoreButton.textContent;
        DOM.restoreButton.disabled = true;
        DOM.restoreButton.textContent = '復元中…';
        try {
            const restored = await EvoluBackup.readBackup(file);
            // 同じバックアップを2回読み込んでも重複しないようにする
            const recordKey = (r) => `${r.date}|${r.memo}|${typeof r.image === 'string' ? r.image.length : r.image.size}`;
            const existing = new Set(records.map(recordKey));
            let added = 0;
            for (const record of restored) {
                if (existing.has(recordKey(record))) continue;
                record.id = await addRecordToDB(record);
                records.push(record);
                existing.add(recordKey(record));
                added++;
            }
            records.sort(compareRecords);
            currentIndex = Math.max(records.length - 1, 0);
            renderAll();
            requestPersistentStorage();
            DOM.menuDialog.close();
            alert(`${added}件を復元しました。（重複 ${restored.length - added}件はスキップ）`);
        } catch (error) {
            console.error('Restore Error:', error);
            alert('復元に失敗しました: ' + error.message);
        } finally {
            DOM.restoreButton.textContent = originalText;
            DOM.restoreButton.disabled = false;
        }
    });

    // -----------------------------------------------------------------
    // 動画の書き出し
    // -----------------------------------------------------------------
    let videoAbort = null;
    let videoResult = null;
    let videoUrl = null;

    function showVideoView(view) {
        DOM.videoOptionsView.hidden = view !== 'options';
        DOM.videoProgressView.hidden = view !== 'progress';
        DOM.videoResultView.hidden = view !== 'result';
    }

    function clearVideoResult() {
        DOM.videoPreview.pause();
        DOM.videoPreview.removeAttribute('src');
        DOM.videoPreview.load();
        if (videoUrl) URL.revokeObjectURL(videoUrl);
        videoUrl = null;
        videoResult = null;
    }

    function updateVideoSummary() {
        const seconds = parseFloat(DOM.videoSeconds.value);
        if (!(seconds > 0)) {
            DOM.videoSummary.textContent = `写真 ${records.length}枚`;
            return;
        }
        const ending = DOM.videoEnding.checked && records.length > 1 ? 3 : 0;
        const total = Math.round(records.length * seconds + ending);
        DOM.videoSummary.textContent = `写真 ${records.length}枚 ・ 動画の長さ 約${total}秒`;
    }

    DOM.createVideoButton.addEventListener('click', () => {
        if (records.length === 0) return;
        stopSlideshow();
        DOM.videoSeconds.value = parseFloat(DOM.timeInput.value).toFixed(1);
        updateVideoSummary();
        showVideoView('options');
        DOM.videoDialog.showModal();
    });

    DOM.videoSeconds.addEventListener('input', updateVideoSummary);
    DOM.videoEnding.addEventListener('change', updateVideoSummary);
    function closeVideoDialog() {
        DOM.videoDialog.close();
        clearVideoResult();
    }

    DOM.videoCloseButton.addEventListener('click', closeVideoDialog);
    DOM.videoDoneButton.addEventListener('click', closeVideoDialog);
    DOM.videoCancelButton.addEventListener('click', () => { if (videoAbort) videoAbort.abort(); });

    DOM.videoRetryButton.addEventListener('click', () => {
        clearVideoResult();
        showVideoView('options');
    });

    DOM.videoDialog.addEventListener('cancel', (event) => {
        // Escキーなどで閉じられたときは、作成中の処理も止める
        if (videoAbort) {
            event.preventDefault();
            videoAbort.abort();
        }
    });

    DOM.videoDialog.addEventListener('close', () => {
        if (!DOM.videoDialog.open) clearVideoResult();
    });

    DOM.videoStartButton.addEventListener('click', async () => {
        const secondsPerPhoto = parseFloat(DOM.videoSeconds.value);
        if (!(secondsPerPhoto >= 0.1 && secondsPerPhoto <= 10)) {
            alert('1枚あたりの秒数は0.1〜10秒で指定してください。');
            return;
        }

        videoAbort = new AbortController();
        DOM.videoProgressBar.value = 0;
        DOM.videoProgressText.textContent = '準備中…';
        showVideoView('progress');

        try {
            const result = await EvoluVideo.renderVideo(records, {
                format: DOM.videoFormat.value,
                secondsPerPhoto,
                captions: DOM.videoCaptions.checked,
                ending: DOM.videoEnding.checked,
                watermark: DOM.videoWatermark.checked
            }, {
                signal: videoAbort.signal,
                onProgress: (ratio) => {
                    DOM.videoProgressBar.value = ratio;
                    DOM.videoProgressText.textContent = `作成中… ${Math.round(ratio * 100)}%`;
                }
            });

            videoResult = result;
            videoUrl = URL.createObjectURL(result.blob);
            DOM.videoPreview.src = videoUrl;

            const sizeMb = (result.blob.size / 1024 / 1024).toFixed(1);
            const notes = [`${result.extension.toUpperCase()} ・ ${sizeMb}MB`];
            if (result.skipped > 0) notes.push(`読み込めなかった写真 ${result.skipped}枚を除きました`);
            DOM.videoResultNote.textContent = notes.join(' / ');
            showVideoView('result');
        } catch (error) {
            showVideoView('options');
            if (error.name !== 'AbortError') {
                console.error('Video Error:', error);
                alert('動画の作成に失敗しました: ' + error.message);
            }
        } finally {
            videoAbort = null;
        }
    });

    DOM.videoSaveButton.addEventListener('click', async () => {
        if (!videoResult) return;
        const filename = `evolu-${formatDate(new Date())}.${videoResult.extension}`;
        await saveFile(videoResult.blob, filename);
    });

    // -----------------------------------------------------------------
    // DB接続と初期データロード（すべての処理を定義したあとに行う）
    // -----------------------------------------------------------------
    try {
        await openDB();
        await migrateLegacyRecords((done, total) => {
            DOM.viewerSection.hidden = false;
            DOM.recordMemo.textContent = `データを最適化しています… ${done} / ${total}`;
        });
        records = await getAllRecordsFromDB();
        currentIndex = records.length > 0 ? records.length - 1 : 0;
        renderAll();
    } catch (error) {
        console.error('Initialization Error:', error);
        alert('初期化エラー: ' + error);
    }
};
