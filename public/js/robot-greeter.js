/**
 * ROBOT GREETER 3D - Procedural WebGL AI Robot & Dual-Engine Speech System
 * Adapted from Google AI Studio for Digital Work AI Exhibition : MENEMBUS BATAS DIGITAL
 * Waroeng Latte Madiun • 11 November 2026
 */

(function () {
    let scene, camera, renderer, clock;
    let robotRoot, torsoGroup, headGroup, leftEye, rightEye;
    let voiceBars = [], wavingArm, restingArm, leftEar, rightEar;
    let instancedNodes, nodeOrbits = [];
    let glowingCyanMat, contactShadowMesh;
    // Animation & Position Targets
    let targetPosX = 0;
    let targetPosY = 0.28;
    let isSpeaking = false;
    let currentAction = 'idle';
    let animFrameId = null;
    let containerElement = null;

    // Temporary math helpers (Lazily initialized once Three.js is ready)
    let _dummyMatrix = null;
    let _dummyPos = null;
    let _dummyQuat = null;
    let _dummyScale = null;
    let _dummyColor = null;
    let _upAxis = null;

    function initThreeHelpers() {
        if (!_dummyMatrix && typeof THREE !== 'undefined') {
            _dummyMatrix = new THREE.Matrix4();
            _dummyPos = new THREE.Vector3();
            _dummyQuat = new THREE.Quaternion();
            _dummyScale = new THREE.Vector3();
            _dummyColor = new THREE.Color();
            _upAxis = new THREE.Vector3(0, 1, 0);
        }
    }

    // Audio State
    let audioCtx = null;
    let activeAudio = null;
    let speechTimer = null;

    // Cache best Indonesian female voice
    let cachedFemaleVoice = null;

    function getBestIndonesianFemaleVoice() {
        if (!('speechSynthesis' in window)) return null;
        const voices = window.speechSynthesis.getVoices() || [];
        if (!voices.length) return null;

        // 1. First priority: Microsoft Gadis / Ayu Online Natural (Standard on Windows 10/11 & Edge)
        const naturalFemale = voices.find(v => 
            (v.name.includes('Gadis') || v.name.includes('Ayu')) && 
            (v.lang.includes('id') || v.lang.includes('ID'))
        );
        if (naturalFemale) return naturalFemale;

        // 2. Second priority: Google Bahasa Indonesia Female (Chrome/Android)
        const googleId = voices.find(v => 
            (v.name.includes('Google') || v.name.includes('Natural')) && 
            (v.lang.includes('id') || v.lang.includes('ID'))
        );
        if (googleId) return googleId;

        // 3. Third priority: Any voice marked female in ID
        const idFemale = voices.find(v => 
            (v.lang.toLowerCase().includes('id')) && 
            (v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('wanita') || v.name.toLowerCase().includes('gadis'))
        );
        if (idFemale) return idFemale;

        // 4. Any Indonesian voice
        const anyId = voices.find(v => v.lang.toLowerCase().includes('id'));
        if (anyId) return anyId;

        return null;
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.onvoiceschanged = () => {
            cachedFemaleVoice = getBestIndonesianFemaleVoice();
        };
    }

    function getAudioContext() {
        if (!audioCtx) {
            try {
                const AudioClass = window.AudioContext || window.webkitAudioContext;
                if (AudioClass) audioCtx = new AudioClass();
            } catch (e) {
                console.warn('[AudioContext] Could not create AudioContext:', e.message);
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            try {
                audioCtx.resume().catch(() => {});
            } catch (e) {}
        }
        return audioCtx;
    }

    function playWelcomeChime() {
        try {
            const ctx = getAudioContext();
            if (!ctx) return;
            const now = ctx.currentTime;
            // Warm futuristic major 9th chord arpeggio (C5, E5, G5, B5, D6)
            const freqs = [523.25, 659.25, 783.99, 987.77, 1174.66];
            freqs.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = i % 2 === 0 ? 'sine' : 'triangle';
                osc.frequency.setValueAtTime(freq, now + i * 0.075);
                gain.gain.setValueAtTime(0.0001, now + i * 0.075);
                gain.gain.exponentialRampToValueAtTime(0.08, now + i * 0.075 + 0.04);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.075 + 0.85);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + i * 0.075);
                osc.stop(now + i * 0.075 + 0.9);
            });
        } catch (e) {}
    }

    function stopActiveSpeech() {
        if (activeAudio) {
            activeAudio.pause();
            activeAudio = null;
        }
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        if (speechTimer) {
            clearTimeout(speechTimer);
            speechTimer = null;
        }
        setSpeaking(false);
    }

    function expandSpeechText(text) {
        if (!text) return '';
        let t = text;

        const replaceWord = (pattern, replacement) => {
            const re = new RegExp('(^|[\\s(])' + pattern + '(\\.|(?=[\\s,)]|$))', 'gi');
            t = t.replace(re, (match, prefix) => prefix + replacement);
        };

        // Social honorifics (Sapaan kehormatan)
        replaceWord('bpk', 'Bapak');
        replaceWord('bu', 'Ibu');
        replaceWord('sdr', 'Saudara');
        replaceWord('sdri', 'Saudari');

        // Religious & Academic titles (Gelar Keagamaan & Keilmuan)
        replaceWord('k\\.?h', 'Kiai Haji');
        replaceWord('kh', 'Kiai Haji');
        replaceWord('prof', 'Profesor');
        replaceWord('ir', 'Insinyur');
        replaceWord('drg', 'Dokter Gigi');
        replaceWord('dr', 'Dokter');
        replaceWord('drs', 'Doktorandus');
        replaceWord('dra', 'Doktoranda');
        replaceWord('ust', 'Ustadz');
        replaceWord('h', 'Haji');
        replaceWord('hj', 'Hajjah');

        // Academic degrees (Gelar Pendidikan / Kesarjanaan)
        replaceWord('s\\.?h', 'Sarjana Hukum');
        replaceWord('sh', 'Sarjana Hukum');
        replaceWord('s\\.?kom', 'Sarjana Komputer');
        replaceWord('skom', 'Sarjana Komputer');
        replaceWord('s\\.?e', 'Sarjana Ekonomi');
        replaceWord('se', 'Sarjana Ekonomi');
        replaceWord('s\\.?pd', 'Sarjana Pendidikan');
        replaceWord('spd', 'Sarjana Pendidikan');
        replaceWord('s\\.?t', 'Sarjana Teknik');
        replaceWord('st', 'Sarjana Teknik');
        replaceWord('s\\.?sos', 'Sarjana Sosial');
        replaceWord('ssos', 'Sarjana Sosial');
        replaceWord('s\\.?si', 'Sarjana Sains');
        replaceWord('ssi', 'Sarjana Sains');
        replaceWord('m\\.?m', 'Magister Manajemen');
        replaceWord('mm', 'Magister Manajemen');
        replaceWord('m\\.?pd', 'Magister Pendidikan');
        replaceWord('mpd', 'Magister Pendidikan');
        replaceWord('m\\.?kom', 'Magister Komputer');
        replaceWord('mkom', 'Magister Komputer');
        replaceWord('m\\.?t', 'Magister Teknik');
        replaceWord('mt', 'Magister Teknik');
        replaceWord('m\\.?si', 'Magister Sains');
        replaceWord('msi', 'Magister Sains');
        replaceWord('m\\.?h', 'Magister Hukum');
        replaceWord('mh', 'Magister Hukum');

        // Institutional abbreviations
        replaceWord('pt', 'P T');
        replaceWord('cv', 'C V');
        replaceWord('kab', 'Kabupaten');
        replaceWord('kec', 'Kecamatan');
        replaceWord('kel', 'Kelurahan');

        return t.replace(/\s+/g, ' ').trim();
    }

    async function speakText(rawText, onComplete) {
        stopActiveSpeech();
        if (!rawText || !rawText.trim()) return;

        // Phonetic expansion for abbreviations (bpk -> Bapak, dr -> Dokter, etc.)
        const text = expandSpeechText(rawText);

        playWelcomeChime();
        setSpeaking(true);
        setAction('greeting');

        const estimatedDuration = Math.max(4500, Math.min(10000, text.length * 65));

        const finish = () => {
            setSpeaking(false);
            setAction('idle');
            if (typeof onComplete === 'function') onComplete();
        };

        // 1. Try Gemini TTS Endpoint (hard 3s timeout so fallback voice is never delayed)
        try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const abortTimer = controller ? setTimeout(() => controller.abort(), 3000) : null;
            const res = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
                signal: controller ? controller.signal : undefined
            });
            if (abortTimer) clearTimeout(abortTimer);
            if (res.ok) {
                const json = await res.json();
                if (!json.fallback && json.audioBase64) {
                    const audio = new Audio(`data:${json.mimeType || 'audio/wav'};base64,${json.audioBase64}`);
                    activeAudio = audio;
                    audio.onended = () => {
                        activeAudio = null;
                        finish();
                    };
                    audio.onerror = () => {
                        activeAudio = null;
                        speakWithBrowser(text, estimatedDuration, finish);
                    };
                    await audio.play();
                    return;
                }
            }
        } catch (e) {}

        // 2. Fallback to Browser Speech Synthesis
        speakWithBrowser(text, estimatedDuration, finish);
    }

    function buildUtterance(text, useSelectedVoice) {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'id-ID';
        utter.rate = 0.94; // Warm, articulate, natural tempo
        utter.pitch = 1.02; // Friendly natural female pitch
        utter.volume = 1;
        if (useSelectedVoice) {
            const bestVoice = cachedFemaleVoice || getBestIndonesianFemaleVoice();
            if (bestVoice) utter.voice = bestVoice;
        }
        return utter;
    }

    function speakWithBrowser(text, estimatedDuration, onDone) {
        if (!('speechSynthesis' in window)) {
            speechTimer = setTimeout(onDone, estimatedDuration);
            return;
        }

        let done = false;
        let retried = false;
        const wrap = () => {
            if (done) return;
            done = true;
            if (speechTimer) clearTimeout(speechTimer);
            onDone();
        };

        const attempt = (useSelectedVoice) => {
            try {
                const utter = buildUtterance(text, useSelectedVoice);
                utter.onend = wrap;
                utter.onerror = (ev) => {
                    const reason = ev && ev.error ? ev.error : '';
                    // Selected (online/natural) voice failed -> retry once with system default Indonesian voice
                    if (!retried && reason !== 'interrupted' && reason !== 'canceled') {
                        retried = true;
                        window.speechSynthesis.cancel();
                        setTimeout(() => attempt(false), 120);
                        return;
                    }
                    wrap();
                };
                window.speechSynthesis.resume();
                window.speechSynthesis.speak(utter);
            } catch (e) {
                wrap();
            }
        };

        window.speechSynthesis.cancel();
        speechTimer = setTimeout(wrap, estimatedDuration + 4000);
        // Chrome/Edge bug: speak() immediately after cancel() can be silently dropped
        setTimeout(() => attempt(true), 150);
    }

    // Unlock audio after first user gesture (browser autoplay policy)
    let audioUnlocked = false;
    function unlockAudio() {
        if (audioUnlocked) return true;
        audioUnlocked = true;
        try {
            const ctx = getAudioContext();
            if (ctx) {
                const buf = ctx.createBuffer(1, 1, 22050);
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(ctx.destination);
                src.start(0);
            }
        } catch (e) {}
        try {
            if ('speechSynthesis' in window) {
                cachedFemaleVoice = getBestIndonesianFemaleVoice();
                const warm = new SpeechSynthesisUtterance(' ');
                warm.volume = 0;
                window.speechSynthesis.speak(warm);
            }
        } catch (e) {}
        return true;
    }

    function setAction(state) {
        currentAction = state;
    }

    function setSpeaking(speaking) {
        isSpeaking = !!speaking;
    }

    function createRoundedRectShape(w, h, r) {
        const shape = new THREE.Shape();
        const x = -w / 2;
        const y = -h / 2;
        shape.moveTo(x + r, y);
        shape.lineTo(x + w - r, y);
        shape.quadraticCurveTo(x + w, y, x + w, y + r);
        shape.lineTo(x + w, y + h - r);
        shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        shape.lineTo(x + r, y + h);
        shape.quadraticCurveTo(x, y + h, x, y + h - r);
        shape.lineTo(x, y + r);
        shape.quadraticCurveTo(x, y, x + r, y);
        return shape;
    }

    function init(containerId) {
        if (typeof THREE === 'undefined') {
            console.warn('[Robot3D] THREE is still loading, retrying in 200ms...');
            setTimeout(() => init(containerId), 200);
            return;
        }
        initThreeHelpers();
        containerElement = document.getElementById(containerId);
        if (!containerElement) return;

        const width = containerElement.clientWidth || 400;
        const height = containerElement.clientHeight || 500;

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 100);
        camera.position.set(0, 1.38, 4.3);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;

        containerElement.innerHTML = '';
        containerElement.appendChild(renderer.domElement);

        // Lighting Rig
        const hemiLight = new THREE.HemisphereLight(0x00F0FF, 0x050814, 1.0);
        hemiLight.position.set(0, 10, 0);
        scene.add(hemiLight);

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
        keyLight.position.set(3, 5, 4);
        scene.add(keyLight);

        const blueFill = new THREE.DirectionalLight(0x0077FE, 1.2);
        blueFill.position.set(-4, 2, 3);
        scene.add(blueFill);

        const purpleRim = new THREE.DirectionalLight(0xBD00FF, 1.4);
        purpleRim.position.set(0, 4, -4);
        scene.add(purpleRim);

        // Materials
        const pearlWhiteMat = new THREE.MeshStandardMaterial({
            color: 0xf8fafc,
            metalness: 0.05,
            roughness: 0.2
        });

        const vividBlueMat = new THREE.MeshStandardMaterial({
            color: 0x0077FE,
            emissive: 0x002d6b,
            emissiveIntensity: 0.35,
            metalness: 0.15,
            roughness: 0.25
        });

        const deepBlueRimMat = new THREE.MeshStandardMaterial({
            color: 0x080e21,
            metalness: 0.4,
            roughness: 0.4
        });

        const blackScreenMat = new THREE.MeshStandardMaterial({
            color: 0x050912,
            metalness: 0.2,
            roughness: 0.1
        });

        glowingCyanMat = new THREE.MeshStandardMaterial({
            color: 0x00F0FF,
            emissive: 0x00F0FF,
            emissiveIntensity: 2.2,
            roughness: 0.1
        });

        const eyeCatchlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

        // Contact Shadow
        const shadowCanvas = document.createElement('canvas');
        shadowCanvas.width = 256;
        shadowCanvas.height = 256;
        const sCtx = shadowCanvas.getContext('2d');
        const grad = sCtx.createRadialGradient(128, 128, 15, 128, 128, 115);
        grad.addColorStop(0, 'rgba(0, 240, 255, 0.45)');
        grad.addColorStop(0.5, 'rgba(189, 0, 255, 0.2)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        sCtx.fillStyle = grad;
        sCtx.fillRect(0, 0, 256, 256);
        const shadowTex = new THREE.CanvasTexture(shadowCanvas);

        // Stage & Podium
        const stageGroup = new THREE.Group();
        scene.add(stageGroup);

        const podiumBase = new THREE.Mesh(
            new THREE.CylinderGeometry(1.2, 1.35, 0.1, 48),
            deepBlueRimMat
        );
        podiumBase.position.y = 0.05;
        stageGroup.add(podiumBase);

        const podiumGlowRing = new THREE.Mesh(
            new THREE.RingGeometry(1.08, 1.15, 48),
            glowingCyanMat
        );
        podiumGlowRing.rotation.x = -Math.PI / 2;
        podiumGlowRing.position.y = 0.105;
        stageGroup.add(podiumGlowRing);

        contactShadowMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(1.9, 1.9),
            new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.85 })
        );
        contactShadowMesh.rotation.x = -Math.PI / 2;
        contactShadowMesh.position.y = 0.108;
        stageGroup.add(contactShadowMesh);

        // Robot Root
        robotRoot = new THREE.Group();
        robotRoot.position.set(0, 0.28, 0);
        scene.add(robotRoot);

        torsoGroup = new THREE.Group();
        torsoGroup.position.set(0, 0.54, 0);
        robotRoot.add(torsoGroup);

        // Lower Belly (White Ovoid)
        const bellyPoints = [];
        for (let i = 0; i <= 20; i++) {
            const t = (i / 20) * Math.PI * 0.56;
            bellyPoints.push(new THREE.Vector2(Math.sin(t) * 0.48, -Math.cos(t) * 0.54));
        }
        const bellyMesh = new THREE.Mesh(new THREE.LatheGeometry(bellyPoints, 36), pearlWhiteMat);
        torsoGroup.add(bellyMesh);

        // Blue Upper Chest Dome
        const chestPoints = [];
        for (let i = 0; i <= 20; i++) {
            const t = Math.PI * 0.52 + (i / 20) * (Math.PI * 0.48);
            chestPoints.push(new THREE.Vector2(Math.sin(t) * 0.502, -Math.cos(t) * 0.43));
        }
        const chestMesh = new THREE.Mesh(new THREE.LatheGeometry(chestPoints, 36), vividBlueMat);
        torsoGroup.add(chestMesh);

        // Front Center Tab
        const tabShape = createRoundedRectShape(0.16, 0.38, 0.07);
        const tabGeo = new THREE.ExtrudeGeometry(tabShape, { depth: 0.08, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.02, bevelThickness: 0.02 });
        tabGeo.center();
        const frontTabMesh = new THREE.Mesh(tabGeo, vividBlueMat);
        frontTabMesh.position.set(0, -0.09, 0.44);
        frontTabMesh.rotation.x = -0.16;
        torsoGroup.add(frontTabMesh);

        // Glowing Chest Core Button
        const coreButton = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.035, 24), glowingCyanMat);
        coreButton.rotation.x = Math.PI / 2 - 0.2;
        coreButton.position.set(0, 0.11, 0.47);
        torsoGroup.add(coreButton);

        // Head Group
        headGroup = new THREE.Group();
        headGroup.position.set(0, 0.88, 0.02);
        torsoGroup.add(headGroup);

        const headShape = createRoundedRectShape(0.88, 0.58, 0.22);
        const headGeo = new THREE.ExtrudeGeometry(headShape, { depth: 0.36, bevelEnabled: true, bevelSegments: 6, steps: 2, bevelSize: 0.11, bevelThickness: 0.11 });
        headGeo.center();
        headGroup.add(new THREE.Mesh(headGeo, pearlWhiteMat));

        // Screen Bezel & Visor
        const screenShape = createRoundedRectShape(0.75, 0.45, 0.14);
        const screenGeo = new THREE.ExtrudeGeometry(screenShape, { depth: 0.04, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.01, bevelThickness: 0.01 });
        screenGeo.center();
        const screenMesh = new THREE.Mesh(screenGeo, blackScreenMat);
        screenMesh.position.set(0, 0, 0.315);
        headGroup.add(screenMesh);

        // Facial Features Container
        const faceFeatures = new THREE.Group();
        faceFeatures.position.set(0, 0, 0.352);
        headGroup.add(faceFeatures);

        // 3D Eyes
        function makeEye(side) {
            const socket = new THREE.Group();
            socket.position.set(side * 0.145, 0.02, 0);

            const crescent = new THREE.Shape();
            crescent.absarc(0, -0.025, 0.088, Math.PI * 0.12, Math.PI * 0.88, false);
            crescent.absarc(0, -0.042, 0.052, Math.PI * 0.84, Math.PI * 0.16, true);
            crescent.closePath();

            const cGeo = new THREE.ExtrudeGeometry(crescent, { depth: 0.014, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.005, bevelThickness: 0.005 });
            cGeo.center();
            socket.add(new THREE.Mesh(cGeo, glowingCyanMat));

            const spark = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 10), eyeCatchlightMat);
            spark.position.set(side * 0.028, 0.024, 0.01);
            socket.add(spark);

            return socket;
        }

        leftEye = makeEye(-1);
        rightEye = makeEye(1);
        faceFeatures.add(leftEye);
        faceFeatures.add(rightEye);

        // 7-bar Voice Equalizer Mouth
        voiceBars = [];
        const barGeo = new THREE.BoxGeometry(0.018, 0.024, 0.012);
        for (let i = 0; i < 7; i++) {
            const bar = new THREE.Mesh(barGeo, glowingCyanMat);
            const offset = i - 3;
            bar.position.set(offset * 0.032, -0.105 + Math.pow(offset / 3, 2) * 0.022, 0);
            faceFeatures.add(bar);
            voiceBars.push(bar);
        }

        // Ears with Antenna Fins
        function makeEar(side) {
            const earGroup = new THREE.Group();
            earGroup.position.set(side * 0.56, -0.02, 0);

            const dome = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), vividBlueMat);
            dome.scale.set(0.58, 1.08, 0.96);
            earGroup.add(dome);

            const finGroup = new THREE.Group();
            finGroup.position.set(side * 0.035, 0.26, 0.02);
            finGroup.rotation.z = side * -0.24;
            earGroup.add(finGroup);

            const fin = new THREE.Mesh(new THREE.SphereGeometry(0.078, 16, 16), vividBlueMat);
            fin.scale.set(0.75, 2.4, 0.68);
            finGroup.add(fin);

            return { earGroup, finGroup };
        }

        leftEar = makeEar(-1);
        rightEar = makeEar(1);
        headGroup.add(leftEar.earGroup);
        headGroup.add(rightEar.earGroup);

        // Arms (Waving Arm & Resting Arm)
        function makeArm(side) {
            const pivot = new THREE.Group();
            pivot.position.set(side * 0.68, 0.18, 0.08);

            const cuffPoints = [];
            for (let i = 0; i <= 12; i++) {
                const t = (i / 12) * Math.PI * 0.54;
                cuffPoints.push(new THREE.Vector2(Math.sin(t) * 0.17, Math.cos(t) * 0.18));
            }
            const cuffMesh = new THREE.Mesh(new THREE.LatheGeometry(cuffPoints, 24), vividBlueMat);
            pivot.add(cuffMesh);

            const handPoints = [];
            for (let i = 0; i <= 16; i++) {
                const u = i / 16;
                const r = Math.sin((1 - u * 0.85) * Math.PI * 0.5) * 0.16 * (1 - u * 0.65);
                handPoints.push(new THREE.Vector2(Math.max(0.001, r), -u * 0.42));
            }
            handPoints.push(new THREE.Vector2(0, -0.43));
            const handMesh = new THREE.Mesh(new THREE.LatheGeometry(handPoints, 24), pearlWhiteMat);
            handMesh.scale.set(1.0, 1.0, 0.72);
            pivot.add(handMesh);

            return pivot;
        }

        wavingArm = makeArm(-1);
        restingArm = makeArm(1);
        torsoGroup.add(wavingArm);
        torsoGroup.add(restingArm);

        // 20 Floating Glowing Particles
        const particleCount = 20;
        const pGeo = new THREE.SphereGeometry(0.026, 8, 8);
        const pMat = new THREE.MeshBasicMaterial({ color: 0x00F0FF });
        instancedNodes = new THREE.InstancedMesh(pGeo, pMat, particleCount);
        instancedNodes.frustumCulled = false;

        nodeOrbits = [];
        for (let i = 0; i < particleCount; i++) {
            const radius = 1.4 + (i % 4) * 0.4;
            const angle = (i / particleCount) * Math.PI * 2;
            const speed = 0.25 + (i % 3) * 0.12;
            const yBase = 0.35 + (i % 5) * 0.35;
            const scale = 0.7 + (i % 3) * 0.3;
            nodeOrbits.push({ radius, angle, speed, yBase, scale });
        }
        scene.add(instancedNodes);

        clock = new THREE.Clock();

        // Responsive resize
        window.addEventListener('resize', onWindowResize);

        // Start render loop
        animate();
    }

    function onWindowResize() {
        if (!containerElement || !renderer || !camera) return;
        const w = containerElement.clientWidth || 400;
        const h = containerElement.clientHeight || 500;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }

    function animate() {
        animFrameId = requestAnimationFrame(animate);
        const delta = Math.min(clock.getDelta(), 0.1);
        const elapsed = clock.getElapsedTime();

        // Eye Blinking
        const blinkPulse = Math.sin(elapsed * 1.85);
        const blinkScaleY = blinkPulse > 0.96 ? 0.12 : 1.0;
        leftEye.scale.set(1, blinkScaleY, 1);
        rightEye.scale.set(1, blinkScaleY, 1);

        // Voice Equalizer Mouth Sync
        for (let i = 0; i < voiceBars.length; i++) {
            const dist = Math.abs(i - 3) / 3;
            const scaleY = isSpeaking
                ? 0.7 + (Math.sin(elapsed * 24 + i * 1.2) * 0.5 + 0.5) * (1 - dist * 0.4) * 2.8
                : 0.45;
            voiceBars[i].scale.y = scaleY;
        }

        // Core Pulse
        if (glowingCyanMat) {
            glowingCyanMat.emissiveIntensity = isSpeaking
                ? 2.5 + Math.sin(elapsed * 14) * 0.6
                : 2.0 + Math.sin(elapsed * 3) * 0.3;
        }

        // Float Hover & Flight Kinematics (Calibrated with top floating emblem)
        const hoverY = 0.16 + Math.sin(elapsed * 2.4) * 0.045;
        robotRoot.position.y = THREE.MathUtils.damp(robotRoot.position.y, hoverY, 6, delta);

        // Smooth horizontal flight (Fly to right on check-in greeting, return to center on idle)
        let dynamicTargetX = targetPosX;
        if (Math.abs(targetPosX) < 0.05) {
            // Gentle organic sway when in center
            dynamicTargetX = Math.sin(elapsed * 0.75) * 0.04;
        }
        robotRoot.position.x = THREE.MathUtils.damp(robotRoot.position.x, dynamicTargetX, 3.2, delta);

        // Agile Banking Roll when flying
        const velocityX = dynamicTargetX - robotRoot.position.x;
        const targetRollZ = -velocityX * 0.22;
        robotRoot.rotation.z = THREE.MathUtils.damp(robotRoot.rotation.z, targetRollZ, 4.5, delta);

        // Sync contact shadow position
        if (contactShadowMesh) {
            contactShadowMesh.position.x = robotRoot.position.x;
            const shadowScale = (1.0 - Math.sin(elapsed * 2.4) * 0.06);
            contactShadowMesh.scale.set(shadowScale, shadowScale, 1);
        }

        // Kinematics Targets
        let targetTorsoZ = 0.04;
        let targetTorsoY = Math.sin(elapsed * 0.9) * 0.08;
        let targetTorsoX = 0;

        let targetHeadZ = -0.09 + Math.sin(elapsed * 1.8) * 0.04;
        let targetHeadY = Math.sin(elapsed * 1.3) * 0.1;
        let targetHeadX = -0.04;

        let targetWaveArmZ = -2.35 + Math.sin(elapsed * 3.5) * 0.15;
        let targetWaveArmX = 0.25;
        let targetRestArmZ = 0.42 + Math.sin(elapsed * 2.0) * 0.06;
        let targetRestArmX = 0.1;

        if (currentAction === 'greeting' || isSpeaking) {
            targetTorsoX = 0.08 + Math.sin(elapsed * 3.0) * 0.04;
            targetTorsoY = 0.12;
            targetHeadZ = -0.14 + Math.sin(elapsed * 4.5) * 0.08;
            targetHeadX = Math.sin(elapsed * 5.0) * 0.06;
            targetWaveArmZ = -2.45 + Math.sin(elapsed * 9.0) * 0.38;
            targetWaveArmX = 0.38;
            targetRestArmZ = 0.58;
        }

        torsoGroup.rotation.z = THREE.MathUtils.damp(torsoGroup.rotation.z, targetTorsoZ, 5, delta);
        torsoGroup.rotation.y = THREE.MathUtils.damp(torsoGroup.rotation.y, targetTorsoY, 4, delta);
        torsoGroup.rotation.x = THREE.MathUtils.damp(torsoGroup.rotation.x, targetTorsoX, 5, delta);

        headGroup.rotation.z = THREE.MathUtils.damp(headGroup.rotation.z, targetHeadZ, 6, delta);
        headGroup.rotation.y = THREE.MathUtils.damp(headGroup.rotation.y, targetHeadY, 6, delta);
        headGroup.rotation.x = THREE.MathUtils.damp(headGroup.rotation.x, targetHeadX, 6, delta);

        wavingArm.rotation.z = THREE.MathUtils.damp(wavingArm.rotation.z, targetWaveArmZ, 8, delta);
        wavingArm.rotation.x = THREE.MathUtils.damp(wavingArm.rotation.x, targetWaveArmX, 6, delta);

        restingArm.rotation.z = THREE.MathUtils.damp(restingArm.rotation.z, targetRestArmZ, 6, delta);
        restingArm.rotation.x = THREE.MathUtils.damp(restingArm.rotation.x, targetRestArmX, 6, delta);

        leftEar.finGroup.rotation.z = 0.24 + Math.sin(elapsed * 3.2) * 0.06;
        rightEar.finGroup.rotation.z = -0.24 - Math.sin(elapsed * 3.2) * 0.06;

        // Particle Orbits
        if (!_dummyMatrix) initThreeHelpers();
        for (let i = 0; i < nodeOrbits.length; i++) {
            const orb = nodeOrbits[i];
            const a = orb.angle + elapsed * orb.speed;
            _dummyPos.set(Math.cos(a) * orb.radius, orb.yBase + Math.sin(elapsed * 1.6 + i) * 0.08, Math.sin(a) * orb.radius);
            _dummyQuat.setFromAxisAngle(_upAxis, elapsed + i);
            _dummyScale.setScalar(orb.scale);
            _dummyMatrix.compose(_dummyPos, _dummyQuat, _dummyScale);
            instancedNodes.setMatrixAt(i, _dummyMatrix);
        }
        instancedNodes.instanceMatrix.needsUpdate = true;

        renderer.render(scene, camera);
    }

    // Expose global controller
    window.Robot3D = {
        init,
        setAction,
        setSpeaking,
        speakText,
        expandSpeechText,
        stopActiveSpeech,
        unlockAudio,
        isAudioUnlocked: () => audioUnlocked,
        flyToRight: (x = 1.35) => {
            targetPosX = x;
            setAction('greeting');
        },
        flyToCenter: () => {
            targetPosX = 0;
            setAction('idle');
        },
        isAtRight: () => targetPosX > 0.5
    };
})();
