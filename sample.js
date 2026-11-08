/**
 * サンプルデータの生成
 * 初めての人が自分の写真なしで使い方を試せるよう、植物が育つ様子をcanvasで描く。
 * 外部の画像や実在の人物の写真は使わない。
 */
(function (root) {
    const WIDTH = 900;
    const HEIGHT = 1200;
    const INTERVAL_DAYS = 7;

    const STAGES = [
        { memo: '種をまいた', height: 0, leaves: 0 },
        { memo: '芽が出た！', height: 70, leaves: 1 },
        { memo: '本葉が出てきた', height: 150, leaves: 2 },
        { memo: '', height: 250, leaves: 3 },
        { memo: 'ぐんぐん伸びる', height: 360, leaves: 4 },
        { memo: '', height: 460, leaves: 5 },
        { memo: 'つぼみがついた', height: 540, leaves: 6, bud: true },
        { memo: '花が咲いた！', height: 580, leaves: 6, flower: true }
    ];

    function drawLeaf(ctx, x, y, size, direction) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(direction * -0.5);
        ctx.scale(direction, 1);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(size * 0.5, -size * 0.45, size, 0);
        ctx.quadraticCurveTo(size * 0.5, size * 0.35, 0, 0);
        ctx.fill();
        ctx.restore();
    }

    function drawStage(stage, index) {
        const canvas = document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        const ctx = canvas.getContext('2d');

        // 窓辺の光
        const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
        sky.addColorStop(0, '#f6efe2');
        sky.addColorStop(1, '#e3d6c0');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(90, 90, 300, 420);
        ctx.fillRect(420, 90, 300, 420);

        // 棚
        ctx.fillStyle = '#b9946a';
        ctx.fillRect(0, 1020, WIDTH, 180);

        const baseX = WIDTH / 2;
        const soilY = 860;

        // 茎と葉
        if (stage.height > 0) {
            const topY = soilY - stage.height;
            ctx.strokeStyle = '#4f8a2b';
            ctx.lineWidth = 12;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(baseX, soilY);
            ctx.quadraticCurveTo(baseX + 18, (soilY + topY) / 2, baseX, topY);
            ctx.stroke();

            ctx.fillStyle = '#5fa336';
            for (let i = 0; i < stage.leaves; i++) {
                const y = soilY - stage.height * ((i + 1) / (stage.leaves + 1));
                const size = 70 + Math.min(stage.height, 400) * 0.18 - i * 6;
                drawLeaf(ctx, baseX, y, size, i % 2 === 0 ? 1 : -1);
            }

            if (stage.bud) {
                ctx.fillStyle = '#e98aa6';
                ctx.beginPath();
                ctx.ellipse(baseX, topY - 18, 18, 26, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            if (stage.flower) {
                ctx.fillStyle = '#f29bb5';
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI * 2 * i) / 6;
                    ctx.beginPath();
                    ctx.ellipse(baseX + Math.cos(angle) * 46, topY - 30 + Math.sin(angle) * 46, 40, 26, angle, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.fillStyle = '#f7d154';
                ctx.beginPath();
                ctx.arc(baseX, topY - 30, 28, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            // 種
            ctx.fillStyle = '#6b4a2b';
            ctx.beginPath();
            ctx.ellipse(baseX, soilY - 6, 14, 9, 0.3, 0, Math.PI * 2);
            ctx.fill();
        }

        // 鉢
        ctx.fillStyle = '#c86b45';
        ctx.beginPath();
        ctx.moveTo(baseX - 210, soilY);
        ctx.lineTo(baseX + 210, soilY);
        ctx.lineTo(baseX + 160, 1060);
        ctx.lineTo(baseX - 160, 1060);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#b25a37';
        ctx.fillRect(baseX - 230, soilY - 10, 460, 60);
        ctx.fillStyle = '#5a3d27';
        ctx.fillRect(baseX - 205, soilY - 10, 410, 14);

        // 週の表示
        ctx.fillStyle = 'rgba(60, 45, 30, 0.6)';
        ctx.font = '700 44px "Inter", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`WEEK ${index}`, 60, 1150);

        return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    }

    function formatDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    /**
     * @returns {Promise<Array<{image: Blob, date: string, memo: string, sample: true}>>}
     */
    async function createSampleRecords() {
        const today = new Date();
        const records = [];
        for (let i = 0; i < STAGES.length; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() - (STAGES.length - 1 - i) * INTERVAL_DAYS);
            records.push({
                image: await drawStage(STAGES[i], i),
                date: formatDate(date),
                memo: STAGES[i].memo,
                sample: true
            });
        }
        return records;
    }

    root.EvoluSample = { createSampleRecords };
})(window);
