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
            loadedData.sort((a, b) => new Date(a.date) - new Date(b.date));
            resolve(loadedData);
        };
        request.onerror = () => reject(request.error);
    });
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
        exitFullscreenBtn: document.getElementById('exitFullscreenBtn')
    };

    DOM.dateInput.value = formatDate(new Date());

    // DB接続と初期データロード
    try {
        await openDB(); 
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
        if (records.length === 0) {
            DOM.mainImage.src = ''; 
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
        DOM.mainImage.src = currentRecord.image;
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
            DOM.playPauseButton.innerHTML = '<i class="fas fa-play"></i>';
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

        DOM.playPauseButton.innerHTML = '<i class="fas fa-pause"></i>';
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
    DOM.imageInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files && files[0] && files[0].lastModified) {
            DOM.dateInput.value = formatDate(new Date(files[0].lastModified));
        }
    });

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

        /**
         * 画像ファイルをBase64化する非同期処理
         */
        const processFile = (file) => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    // 複数ファイルの場合はファイルの最終更新日、単一の場合はフォームの入力日を優先
                    const recordDate = (inputFiles.length > 1 && file.lastModified) 
                                     ? formatDate(new Date(file.lastModified)) 
                                     : manualDate;

                    resolve({ image: e.target.result, date: recordDate, memo: memo });
                };
                // ※今後の改善点: 画質を圧縮してから保存する処理を挟むとUXが向上する
                reader.readAsDataURL(file);
            });
        };

        try {
            // Promise.allで複数ファイルの処理を並列実行
            const newRecordsData = await Promise.all(Array.from(inputFiles).map(processFile));

            for (let data of newRecordsData) {
                data.id = await addRecordToDB(data);
                records.push(data);
            }

            records.sort((a, b) => new Date(a.date) - new Date(b.date));
            currentIndex = records.length - 1;
            updateDisplay();
            
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
};