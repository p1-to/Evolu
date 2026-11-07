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

const ICON_PLAY = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

// =================================================================
// 4. Main Initialization & UI Controllers (初期化・UI制御)
// =================================================================
window.onload = async function() { 

    // DOM要素のキャッシュ
    const DOM = {
        mainImage: document.getElementById('mainImage'),
        recordDate: document.getElementById('recordDate'),
        recordMemo: document.getElementById('recordMemo'),
        prevButton: document.getElementById('prevButton'),
        nextButton: document.getElementById('nextButton'),
        deleteButton: document.getElementById('deleteButton'),
        deleteAllButton: document.getElementById('deleteAllButton'),
        playPauseButton: document.getElementById('playPauseButton'),
        timeInput: document.getElementById('timeInput'),
        plus05sButton: document.getElementById('plus05sButton'),
        minus05sButton: document.getElementById('minus05sButton'),
        recordForm: document.getElementById('recordForm'),
        dateInput: document.getElementById('dateInput'),
        memoInput: document.getElementById('memoInput'),
        imageInput: document.getElementById('imageInput'),
        exitFullscreenBtn: document.getElementById('exitFullscreenBtn'),
        createVideoButton: document.getElementById('createVideoButton'),
        backupButton: document.getElementById('backupButton'),
        restoreButton: document.getElementById('restoreButton'),
        restoreInput: document.getElementById('restoreInput'),
        videoDialog: document.getElementById('videoDialog'),
        videoOptionsView: document.getElementById('videoOptionsView'),
        videoProgressView: document.getElementById('videoProgressView'),
        videoResultView: document.getElementById('videoResultView'),
        videoFormat: document.getElementById('videoFormat'),
        videoSeconds: document.getElementById('videoSeconds'),
        videoCaptions: document.getElementById('videoCaptions'),
        videoEnding: document.getElementById('videoEnding'),
        videoWatermark: document.getElementById('videoWatermark'),
        videoSummary: document.getElementById('videoSummary'),
        videoStartButton: document.getElementById('videoStartButton'),
        videoCloseButton: document.getElementById('videoCloseButton'),
        videoCancelButton: document.getElementById('videoCancelButton'),
        videoProgressBar: document.getElementById('videoProgressBar'),
        videoProgressText: document.getElementById('videoProgressText'),
        videoPreview: document.getElementById('videoPreview'),
        videoResultNote: document.getElementById('videoResultNote'),
        videoSaveButton: document.getElementById('videoSaveButton'),
        videoRetryButton: document.getElementById('videoRetryButton'),
        videoDoneButton: document.getElementById('videoDoneButton')
    };

    let displayedUrl = null;

    DOM.dateInput.value = formatDate(new Date());

    // DB接続と初期データロード
    try {
        await openDB();
        await migrateLegacyRecords((done, total) => {
            DOM.recordMemo.textContent = `データを最適化しています… ${done} / ${total}`;
        });
        records = await getAllRecordsFromDB();
        currentIndex = records.length > 0 ? records.length - 1 : 0;
        updateDisplay();
    } catch (error) {
        alert('初期化エラー: ' + error);
    }

    /**
     * UIの更新処理
     */
    function updateDisplay() {
        const previousUrl = displayedUrl;
        displayedUrl = null;

        if (records.length === 0) {
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            DOM.mainImage.removeAttribute('src');
            DOM.mainImage.alt = 'No Data';
            DOM.mainImage.style.opacity = '0.3'; 
            DOM.recordDate.textContent = '---';
            DOM.recordMemo.textContent = '記録がありません。新しく追加してください。';
            return; 
        }
        
        DOM.mainImage.style.opacity = '1';

        // インデックスの境界チェック
        if (currentIndex >= records.length) currentIndex = records.length - 1;
        if (currentIndex < 0) currentIndex = 0;
        
        const currentRecord = records[currentIndex]; 
        if (typeof currentRecord.image === 'string') {
            DOM.mainImage.src = currentRecord.image; // 移行できなかった旧形式
        } else {
            displayedUrl = URL.createObjectURL(currentRecord.image);
            DOM.mainImage.src = displayedUrl;
        }
        if (previousUrl) URL.revokeObjectURL(previousUrl);

        DOM.mainImage.alt = `${currentRecord.date} の記録`;
        DOM.recordDate.textContent = currentRecord.date;
        DOM.recordMemo.textContent = currentRecord.memo;
    }

    function showNextRecord() {
        if (records.length === 0) return; 
        currentIndex = (currentIndex + 1) % records.length;
        updateDisplay();
    }

    function stopSlideshow() {
        if (slideInterval !== null) {
            clearInterval(slideInterval);
            slideInterval = null;
            DOM.playPauseButton.innerHTML = ICON_PLAY;
            DOM.playPauseButton.classList.replace('pause-button', 'play-button');
        }
    }

    function startSlideshow() {
        if (records.length <= 1) return;
        stopSlideshow(); 

        const intervalTime = parseFloat(DOM.timeInput.value) * 1000;
        if (intervalTime < 100 || isNaN(intervalTime)) {
            alert('切り替え時間は0.1秒以上を指定してください。');
            DOM.timeInput.value = '3.0'; 
            return;
        }

        DOM.playPauseButton.innerHTML = ICON_PAUSE;
        DOM.playPauseButton.classList.replace('play-button', 'pause-button');
        slideInterval = setInterval(showNextRecord, intervalTime); 
    }

    function updateTimeInput(change) {
        let currentValue = parseFloat(DOM.timeInput.value);
        let newValue = Math.max(0.1, currentValue + change); // 0.1未満にならないよう制御
        DOM.timeInput.value = newValue.toFixed(1);
    }

    // =================================================================
    // 5. Event Listeners (イベント登録)
    // =================================================================

    // 画像選択時に撮影日を自動取得（可能であれば）
    DOM.imageInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) DOM.dateInput.value = await detectPhotoDate(file);
    });

    /** 撮影日（EXIF）→ ファイル更新日 → 今日 の順で日付を決める */
    async function detectPhotoDate(file) {
        const exifDate = await EvoluExif.readExifDate(file);
        if (exifDate) return exifDate;
        return formatDate(file.lastModified ? new Date(file.lastModified) : new Date());
    }

    // --- フルスクリーン制御 ---
    let hideButtonTimer = null;

    function showButtonTemporarily() {
        DOM.exitFullscreenBtn.classList.remove('hidden');
        if (hideButtonTimer) clearTimeout(hideButtonTimer);
        // iOS Safari等でのタップイベント考慮: 3秒後に閉じるボタンを隠す
        hideButtonTimer = setTimeout(() => {
            DOM.exitFullscreenBtn.classList.add('hidden');
        }, 3000); 
    }

    DOM.mainImage.addEventListener('click', () => {
        if (records.length === 0) return;
        document.body.classList.add('fullscreen-mode');
        showButtonTemporarily();
    });

    DOM.exitFullscreenBtn.addEventListener('click', () => {
        document.body.classList.remove('fullscreen-mode');
        if (hideButtonTimer) clearTimeout(hideButtonTimer);
    });
    
    // フルスクリーン中のタップ/クリックでUIを表示
    const handleFullscreenInteraction = () => {
        if (document.body.classList.contains('fullscreen-mode')) {
            showButtonTemporarily();
        }
    };
    document.addEventListener('click', handleFullscreenInteraction);
    document.addEventListener('touchstart', handleFullscreenInteraction);

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
        if (!document.body.classList.contains('fullscreen-mode')) return;
        
        showButtonTemporarily();
        
        switch(e.key) {
            case 'ArrowRight':
                stopSlideshow(); 
                showNextRecord();
                break;
            case 'ArrowLeft':
                stopSlideshow();
                currentIndex = (currentIndex - 1 + records.length) % records.length;
                updateDisplay();
                break;
            case 'Escape':
                document.body.classList.remove('fullscreen-mode');
                break;
        }
    });

    // --- コントロールボタン群 ---
    DOM.nextButton.addEventListener('click', () => { stopSlideshow(); showNextRecord(); });
    DOM.prevButton.addEventListener('click', () => {
        stopSlideshow(); 
        if (records.length === 0) return; 
        currentIndex = (currentIndex - 1 + records.length) % records.length;
        updateDisplay();
    });
    
    DOM.playPauseButton.addEventListener('click', () => {
        slideInterval === null ? startSlideshow() : stopSlideshow();
    });

    DOM.plus05sButton.addEventListener('click', () => { updateTimeInput(0.5); stopSlideshow(); });
    DOM.minus05sButton.addEventListener('click', () => { updateTimeInput(-0.5); stopSlideshow(); });
    
    // --- データ削除 ---
    DOM.deleteButton.addEventListener('click', async () => {
        if (records.length === 0) return;
        const currentRecord = records[currentIndex];
        
        if (!confirm(`日付: ${currentRecord.date}\nこの記録を削除しますか？`)) return;

        try {
            await deleteRecordFromDB(currentRecord.id);
            records.splice(currentIndex, 1);
            if (records.length <= 1) stopSlideshow();
            updateDisplay();
        } catch (e) {
            alert('削除失敗: ' + e);
        }
    });

    DOM.deleteAllButton.addEventListener('click', async () => {
        if (records.length === 0) return;
        if (!confirm('【警告】保存されている全てのデータを削除しますか？')) return;

        try {
            await clearAllRecordsInDB();
            stopSlideshow();
            records = [];
            currentIndex = 0;
            updateDisplay();
        } catch (e) {
            alert('全削除に失敗しました: ' + e);
        }
    });

    // --- データ保存 (File API & Promise) ---
    DOM.recordForm.addEventListener('submit', async (event) => {
        event.preventDefault(); 
        
        const inputFiles = DOM.imageInput.files;
        const memo = DOM.memoInput.value;
        const manualDate = DOM.dateInput.value; 

        if (inputFiles.length === 0) {
            alert('画像を選択してください。');
            return;
        }

        const saveBtn = DOM.recordForm.querySelector('.save-button');
        const originalBtnText = saveBtn.textContent;
        saveBtn.textContent = '保存中...';
        saveBtn.disabled = true;

        try {
            // 1枚ならフォームの日付（手で直せる）、複数なら写真ごとの撮影日を使う
            const files = Array.from(inputFiles);
            for (const file of files) {
                const date = files.length > 1 ? await detectPhotoDate(file) : manualDate;
                const record = { image: file, date, memo };
                record.id = await addRecordToDB(record);
                records.push(record);
            }

            records.sort(compareRecords);
            currentIndex = records.length - 1;
            updateDisplay();
            requestPersistentStorage();

            DOM.recordForm.reset();
            DOM.dateInput.value = formatDate(new Date());

        } catch (error) {
            console.error('Data Save Error:', error);
            alert('保存エラー: ' + error);
        } finally {
            saveBtn.textContent = originalBtnText;
            saveBtn.disabled = false;
        }
    });

    // --- バックアップ ---
    DOM.backupButton.addEventListener('click', async () => {
        if (records.length === 0) {
            alert('バックアップする記録がありません。');
            return;
        }
        const originalText = DOM.backupButton.textContent;
        DOM.backupButton.disabled = true;
        try {
            const blobRecords = records.map((record) => (
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
            updateDisplay();
            requestPersistentStorage();
            alert(`${added}件を復元しました。（重複 ${restored.length - added}件はスキップ）`);
        } catch (error) {
            console.error('Restore Error:', error);
            alert('復元に失敗しました: ' + error.message);
        } finally {
            DOM.restoreButton.textContent = originalText;
            DOM.restoreButton.disabled = false;
        }
    });

    // --- 動画の書き出し ---
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
        if (records.length === 0) {
            alert('先に写真を記録してください。');
            return;
        }
        stopSlideshow();
        const seconds = parseFloat(DOM.timeInput.value);
        DOM.videoSeconds.value = seconds >= 0.1 ? Math.min(seconds, 10).toFixed(1) : '1.0';
        updateVideoSummary();
        showVideoView('options');
        DOM.videoDialog.showModal();
    });

    DOM.videoSeconds.addEventListener('input', updateVideoSummary);
    DOM.videoEnding.addEventListener('change', updateVideoSummary);
    DOM.videoCloseButton.addEventListener('click', () => DOM.videoDialog.close());
    DOM.videoDoneButton.addEventListener('click', () => DOM.videoDialog.close());
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

    DOM.videoDialog.addEventListener('close', clearVideoResult);

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
};