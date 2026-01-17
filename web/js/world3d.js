// World3D - Low-poly cute world with robots for Claudex sessions

class World3D {
    constructor(canvas, onSessionClick, onCreateSession) {
        this.canvas = canvas;
        this.onSessionClick = onSessionClick;
        this.onCreateSession = onCreateSession;
        this.sessions = new Map();
        this.parcels = new Map(); // q,r -> parcel mesh
        this.robots = new Map(); // sessionId -> robot group
        this.emptyParcels = new Map(); // q,r -> empty parcel mesh
        this.isActive = false;

        // Hex grid settings
        this.hexSize = 1.2;
        this.hexHeight = 0.3;
        this.hexSpacing = 0.08;

        // Status colors (pastel/cute)
        this.statusColors = {
            idle: 0x90EE90,      // Light green
            thinking: 0xFFD700,  // Gold
            executing: 0x87CEEB, // Sky blue
            waiting_input: 0xFFB6C1, // Light pink
            stopped: 0xD3D3D3,   // Light gray
            shell: 0xDDA0DD     // Plum
        };

        // Parcel colors
        this.parcelColor = 0x7EC850; // Grass green
        this.parcelEdgeColor = 0x5A9A30; // Darker green
        this.emptyParcelColor = 0x4A7030; // Even darker, semi-transparent

        this.init();
    }

    init() {
        // Scene
        this.scene = new THREE.Scene();

        // Sky gradient background
        this.scene.background = new THREE.Color(0x87CEEB);

        // Camera (isometric-ish view)
        this.camera = new THREE.PerspectiveCamera(
            50,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        this.camera.position.set(8, 10, 8);
        this.camera.lookAt(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight - 60);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // Controls
        this.controls = new THREE.OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 5;
        this.controls.maxDistance = 25;
        this.controls.maxPolarAngle = Math.PI / 2.2;
        this.controls.target.set(0, 0, 0);

        // Lights
        this.setupLights();

        // Environment
        this.createEnvironment();

        // Raycaster
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.hoveredParcel = null;

        // Event listeners
        this.setupEventListeners();

        // Animation
        this.clock = new THREE.Clock();
        this.animate();
    }

    setupLights() {
        // Ambient light (warm)
        const ambient = new THREE.AmbientLight(0xfff5e6, 0.6);
        this.scene.add(ambient);

        // Sun light
        const sun = new THREE.DirectionalLight(0xffffff, 0.8);
        sun.position.set(10, 20, 10);
        sun.castShadow = true;
        sun.shadow.mapSize.width = 2048;
        sun.shadow.mapSize.height = 2048;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 50;
        sun.shadow.camera.left = -15;
        sun.shadow.camera.right = 15;
        sun.shadow.camera.top = 15;
        sun.shadow.camera.bottom = -15;
        this.scene.add(sun);

        // Fill light (bluish from opposite side)
        const fill = new THREE.DirectionalLight(0x87CEEB, 0.3);
        fill.position.set(-5, 5, -5);
        this.scene.add(fill);
    }

    createEnvironment() {
        // Ground plane (water/void below parcels)
        const groundGeo = new THREE.PlaneGeometry(100, 100);
        const groundMat = new THREE.MeshStandardMaterial({
            color: 0x4A90A4,
            roughness: 0.8
        });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.5;
        ground.receiveShadow = true;
        this.scene.add(ground);

        // Clouds
        this.createClouds();
    }

    createClouds() {
        this.clouds = [];
        const cloudCount = 8;

        for (let i = 0; i < cloudCount; i++) {
            const cloud = this.createCloud();
            cloud.position.set(
                (Math.random() - 0.5) * 40,
                8 + Math.random() * 4,
                (Math.random() - 0.5) * 40
            );
            cloud.userData.speed = 0.01 + Math.random() * 0.02;
            this.scene.add(cloud);
            this.clouds.push(cloud);
        }
    }

    createCloud() {
        const cloud = new THREE.Group();
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 1,
            flatShading: true
        });

        // Random cloud shape with spheres
        const parts = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < parts; i++) {
            const size = 0.5 + Math.random() * 0.8;
            const geo = new THREE.IcosahedronGeometry(size, 0);
            const puff = new THREE.Mesh(geo, material);
            puff.position.set(
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 0.5,
                (Math.random() - 0.5) * 1
            );
            cloud.add(puff);
        }

        return cloud;
    }

    // Hexagonal parcel (flat terrain tile)
    createParcelGeometry() {
        const shape = new THREE.Shape();
        const sides = 6;

        for (let i = 0; i < sides; i++) {
            const angle = (i / sides) * Math.PI * 2 - Math.PI / 6;
            const x = Math.cos(angle) * this.hexSize;
            const y = Math.sin(angle) * this.hexSize;

            if (i === 0) {
                shape.moveTo(x, y);
            } else {
                shape.lineTo(x, y);
            }
        }
        shape.closePath();

        const extrudeSettings = {
            depth: this.hexHeight,
            bevelEnabled: true,
            bevelThickness: 0.05,
            bevelSize: 0.05,
            bevelSegments: 1
        };

        return new THREE.ExtrudeGeometry(shape, extrudeSettings);
    }

    createParcel(q, r, session) {
        const group = new THREE.Group();

        // Main parcel (grass top)
        const geometry = this.createParcelGeometry();
        const material = new THREE.MeshStandardMaterial({
            color: this.parcelColor,
            roughness: 0.8,
            flatShading: true
        });

        const parcel = new THREE.Mesh(geometry, material);
        parcel.rotation.x = -Math.PI / 2;
        parcel.castShadow = true;
        parcel.receiveShadow = true;
        group.add(parcel);

        // Edge/dirt layer
        const edgeGeo = this.createParcelGeometry();
        const edgeMat = new THREE.MeshStandardMaterial({
            color: this.parcelEdgeColor,
            roughness: 0.9,
            flatShading: true
        });
        const edge = new THREE.Mesh(edgeGeo, edgeMat);
        edge.rotation.x = -Math.PI / 2;
        edge.position.y = -this.hexHeight;
        edge.scale.set(0.95, 0.95, 1);
        group.add(edge);

        // Name label on the tile
        if (session) {
            const label = this.createTileLabel(session.name || session.id);
            label.position.y = this.hexHeight + 0.01;
            label.rotation.x = -Math.PI / 2;
            group.add(label);
            group.userData.label = label;
        }

        // Position in hex grid
        const pos = this.hexToWorld(q, r);
        group.position.set(pos.x, 0, pos.z);

        group.userData = { q, r, sessionId: session?.id, type: 'parcel' };

        return group;
    }

    createTileLabel(text) {
        const canvas = document.createElement('canvas');
        const size = 256;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Truncate text if too long
        let displayText = text;
        if (displayText.length > 12) {
            displayText = displayText.substring(0, 11) + '…';
        }

        // Draw text
        ctx.font = 'bold 32px Arial, sans-serif';
        ctx.fillStyle = '#2a4a20';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayText, size / 2, size / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false
        });

        const planeGeo = new THREE.PlaneGeometry(this.hexSize * 1.6, this.hexSize * 1.6);
        const mesh = new THREE.Mesh(planeGeo, material);

        mesh.userData.canvas = canvas;
        mesh.userData.ctx = ctx;
        mesh.userData.texture = texture;

        return mesh;
    }

    updateTileLabel(parcel, text) {
        const label = parcel.userData.label;
        if (!label) return;

        const ctx = label.userData.ctx;
        const canvas = label.userData.canvas;
        const size = canvas.width;

        // Truncate text if too long
        let displayText = text;
        if (displayText.length > 12) {
            displayText = displayText.substring(0, 11) + '…';
        }

        // Clear and redraw
        ctx.clearRect(0, 0, size, size);
        ctx.font = 'bold 32px Arial, sans-serif';
        ctx.fillStyle = '#2a4a20';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayText, size / 2, size / 2);

        label.userData.texture.needsUpdate = true;
    }

    createEmptyParcel(q, r) {
        const geometry = this.createParcelGeometry();
        const material = new THREE.MeshStandardMaterial({
            color: this.emptyParcelColor,
            roughness: 0.8,
            flatShading: true,
            transparent: true,
            opacity: 0.3
        });

        const parcel = new THREE.Mesh(geometry, material);
        parcel.rotation.x = -Math.PI / 2;
        parcel.position.y = -0.1;

        const pos = this.hexToWorld(q, r);
        parcel.position.set(pos.x, -0.1, pos.z);

        parcel.userData = { q, r, type: 'empty', isEmpty: true };

        // Plus sign
        const plusGroup = new THREE.Group();
        const plusMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0
        });

        const barGeo = new THREE.BoxGeometry(0.4, 0.05, 0.1);
        const hBar = new THREE.Mesh(barGeo, plusMat);
        const vBar = new THREE.Mesh(barGeo, plusMat);
        vBar.rotation.y = Math.PI / 2;

        plusGroup.add(hBar);
        plusGroup.add(vBar);
        plusGroup.position.y = 0.2;
        plusGroup.userData.plusMaterial = plusMat;

        parcel.add(plusGroup);
        parcel.userData.plusGroup = plusGroup;

        return parcel;
    }

    // Low-poly cute robot
    createRobot(session) {
        const robot = new THREE.Group();
        const status = session.status || 'idle';
        const color = this.statusColors[status] || this.statusColors.idle;

        // Body (rounded box shape using segments)
        const bodyGeo = new THREE.BoxGeometry(0.5, 0.6, 0.4);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: color,
            roughness: 0.3,
            metalness: 0.2,
            flatShading: true
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.6;
        body.castShadow = true;
        robot.add(body);
        robot.userData.body = body;
        robot.userData.bodyMat = bodyMat;

        // Head
        const headGeo = new THREE.BoxGeometry(0.45, 0.35, 0.35);
        const headMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.3,
            metalness: 0.1,
            flatShading: true
        });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.1;
        head.castShadow = true;
        robot.add(head);
        robot.userData.head = head;

        // Eyes
        const eyeGeo = new THREE.BoxGeometry(0.1, 0.1, 0.05);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x333333 });

        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.12, 1.12, 0.17);
        robot.add(leftEye);

        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.12, 1.12, 0.17);
        robot.add(rightEye);

        robot.userData.leftEye = leftEye;
        robot.userData.rightEye = rightEye;

        // Antenna
        const antennaGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.2, 6);
        const antennaMat = new THREE.MeshStandardMaterial({
            color: 0x666666,
            metalness: 0.5
        });
        const antenna = new THREE.Mesh(antennaGeo, antennaMat);
        antenna.position.y = 1.35;
        robot.add(antenna);

        // Antenna ball
        const ballGeo = new THREE.SphereGeometry(0.06, 8, 6);
        const ballMat = new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: 0.3
        });
        const ball = new THREE.Mesh(ballGeo, ballMat);
        ball.position.y = 1.48;
        robot.add(ball);
        robot.userData.antennaBall = ball;
        robot.userData.antennaMat = ballMat;

        // Arms
        const armGeo = new THREE.BoxGeometry(0.12, 0.35, 0.12);
        const armMat = new THREE.MeshStandardMaterial({
            color: 0xaaaaaa,
            roughness: 0.4,
            metalness: 0.3,
            flatShading: true
        });

        const leftArm = new THREE.Mesh(armGeo, armMat);
        leftArm.position.set(-0.35, 0.55, 0);
        leftArm.castShadow = true;
        robot.add(leftArm);
        robot.userData.leftArm = leftArm;

        const rightArm = new THREE.Mesh(armGeo, armMat);
        rightArm.position.set(0.35, 0.55, 0);
        rightArm.castShadow = true;
        robot.add(rightArm);
        robot.userData.rightArm = rightArm;

        // Legs
        const legGeo = new THREE.BoxGeometry(0.15, 0.25, 0.15);
        const legMat = new THREE.MeshStandardMaterial({
            color: 0x666666,
            roughness: 0.5,
            metalness: 0.2,
            flatShading: true
        });

        const leftLeg = new THREE.Mesh(legGeo, legMat);
        leftLeg.position.set(-0.13, 0.2, 0);
        leftLeg.castShadow = true;
        robot.add(leftLeg);

        const rightLeg = new THREE.Mesh(legGeo, legMat);
        rightLeg.position.set(0.13, 0.2, 0);
        rightLeg.castShadow = true;
        robot.add(rightLeg);

        robot.userData.sessionId = session.id;
        robot.userData.session = session;
        robot.userData.status = status;
        robot.userData.animTime = Math.random() * Math.PI * 2; // Random phase

        // Status indicator above head
        this.createStatusIndicator(robot, status);

        return robot;
    }

    createStatusIndicator(robot, status) {
        // Remove old indicator
        if (robot.userData.indicator) {
            robot.remove(robot.userData.indicator);
        }

        const indicator = new THREE.Group();
        indicator.position.y = 1.7;

        if (status === 'thinking') {
            // Question marks
            // Simple floating dots as placeholder
            const dotGeo = new THREE.SphereGeometry(0.05, 6, 4);
            const dotMat = new THREE.MeshBasicMaterial({ color: 0xFFD700 });
            for (let i = 0; i < 3; i++) {
                const dot = new THREE.Mesh(dotGeo, dotMat);
                dot.position.x = (i - 1) * 0.15;
                dot.userData.phase = i * 0.5;
                indicator.add(dot);
            }
        } else if (status === 'waiting_input') {
            // Exclamation mark (simple)
            const excGeo = new THREE.BoxGeometry(0.08, 0.25, 0.08);
            const excMat = new THREE.MeshBasicMaterial({ color: 0xFFB6C1 });
            const exc = new THREE.Mesh(excGeo, excMat);
            indicator.add(exc);

            const dotGeo = new THREE.BoxGeometry(0.08, 0.08, 0.08);
            const dot = new THREE.Mesh(dotGeo, excMat);
            dot.position.y = -0.22;
            indicator.add(dot);
        } else if (status === 'executing') {
            // Gear/cog (simple)
            const gearGeo = new THREE.TorusGeometry(0.12, 0.03, 6, 6);
            const gearMat = new THREE.MeshBasicMaterial({ color: 0x87CEEB });
            const gear = new THREE.Mesh(gearGeo, gearMat);
            gear.rotation.x = Math.PI / 2;
            indicator.add(gear);
        } else if (status === 'idle') {
            // Zzz
            const zMat = new THREE.MeshBasicMaterial({ color: 0x90EE90, transparent: true, opacity: 0.7 });
            for (let i = 0; i < 2; i++) {
                const zGeo = new THREE.BoxGeometry(0.1 - i * 0.03, 0.02, 0.02);
                const z = new THREE.Mesh(zGeo, zMat);
                z.position.set(0.1 + i * 0.15, i * 0.15, 0);
                z.userData.phase = i * 0.3;
                indicator.add(z);
            }
        }

        robot.add(indicator);
        robot.userData.indicator = indicator;
    }

    updateRobotStatus(robot, status) {
        const color = this.statusColors[status] || this.statusColors.idle;

        // Update body color
        robot.userData.bodyMat.color.setHex(color);

        // Update antenna ball
        robot.userData.antennaMat.color.setHex(color);
        robot.userData.antennaMat.emissive.setHex(color);

        robot.userData.status = status;

        // Update indicator
        this.createStatusIndicator(robot, status);
    }

    // Hex coordinate conversions (pointy-top)
    hexToWorld(q, r) {
        const size = this.hexSize + this.hexSpacing;
        const x = size * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r);
        const z = size * (3 / 2 * r);
        return { x, z };
    }

    worldToHex(x, z) {
        const size = this.hexSize + this.hexSpacing;
        const q = (Math.sqrt(3) / 3 * x - 1 / 3 * z) / size;
        const r = (2 / 3 * z) / size;
        return this.hexRound(q, r);
    }

    hexRound(q, r) {
        const s = -q - r;
        let rq = Math.round(q);
        let rr = Math.round(r);
        let rs = Math.round(s);

        const qDiff = Math.abs(rq - q);
        const rDiff = Math.abs(rr - r);
        const sDiff = Math.abs(rs - s);

        if (qDiff > rDiff && qDiff > sDiff) {
            rq = -rr - rs;
        } else if (rDiff > sDiff) {
            rr = -rq - rs;
        }

        return { q: rq, r: rr };
    }

    getHexNeighbors(q, r) {
        const directions = [
            { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
            { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }
        ];
        return directions.map(d => ({ q: q + d.q, r: r + d.r }));
    }

    // Session management
    updateSessions(sessionsMap) {
        this.sessions = sessionsMap;

        // Clear old
        this.parcels.forEach((parcel, key) => {
            this.scene.remove(parcel);
        });
        this.parcels.clear();

        this.robots.forEach((robot, id) => {
            this.scene.remove(robot);
        });
        this.robots.clear();

        this.emptyParcels.forEach((parcel, key) => {
            this.scene.remove(parcel);
        });
        this.emptyParcels.clear();

        // Assign positions to sessions (spiral from center)
        const positions = this.getSpiralPositions(sessionsMap.size);
        let i = 0;

        sessionsMap.forEach((session, id) => {
            const { q, r } = positions[i];

            // Create parcel
            const parcel = this.createParcel(q, r, session);
            this.scene.add(parcel);
            this.parcels.set(`${q},${r}`, parcel);

            // Create robot
            const robot = this.createRobot(session);
            const pos = this.hexToWorld(q, r);
            robot.position.set(pos.x, this.hexHeight, pos.z);
            this.scene.add(robot);
            this.robots.set(id, robot);

            // Store position in session for reference
            session._hexQ = q;
            session._hexR = r;

            i++;
        });

        // Create empty parcels around occupied ones
        this.updateEmptyParcels();
    }

    getSpiralPositions(count) {
        if (count === 0) return [{ q: 0, r: 0 }];

        const positions = [{ q: 0, r: 0 }];
        if (count === 1) return positions;

        const directions = [
            { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
            { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }
        ];

        let q = 0, r = 0;
        let ring = 1;

        while (positions.length < count) {
            // Move to start of ring
            q += 1;
            r += 0;

            for (let side = 0; side < 6 && positions.length < count; side++) {
                for (let step = 0; step < ring && positions.length < count; step++) {
                    positions.push({ q, r });
                    q += directions[(side + 2) % 6].q;
                    r += directions[(side + 2) % 6].r;
                }
            }
            ring++;
        }

        return positions;
    }

    updateEmptyParcels() {
        // Find all neighbors of occupied parcels that are not occupied
        const occupied = new Set();
        this.parcels.forEach((_, key) => occupied.add(key));

        const emptyPositions = new Set();

        this.parcels.forEach((parcel, key) => {
            const { q, r } = parcel.userData;
            const neighbors = this.getHexNeighbors(q, r);

            neighbors.forEach(n => {
                const nKey = `${n.q},${n.r}`;
                if (!occupied.has(nKey)) {
                    emptyPositions.add(nKey);
                }
            });
        });

        // If no parcels, add center
        if (this.parcels.size === 0) {
            emptyPositions.add('0,0');
        }

        // Create empty parcel meshes
        emptyPositions.forEach(key => {
            const [q, r] = key.split(',').map(Number);
            const empty = this.createEmptyParcel(q, r);
            this.scene.add(empty);
            this.emptyParcels.set(key, empty);
        });
    }

    updateSessionStatus(sessionId, status) {
        const robot = this.robots.get(sessionId);
        if (robot) {
            this.updateRobotStatus(robot, status);
        }
    }

    updateSessionName(sessionId, name) {
        // Find parcel with this session
        this.parcels.forEach(parcel => {
            if (parcel.userData.sessionId === sessionId) {
                this.updateTileLabel(parcel, name);
            }
        });
    }

    // Event handling
    setupEventListeners() {
        // Track mousedown for click vs drag detection
        this.mouseDownTime = 0;
        this.mouseDownPos = { x: 0, y: 0 };

        this.canvas.addEventListener('mousedown', (e) => {
            this.mouseDownTime = Date.now();
            this.mouseDownPos = { x: e.clientX, y: e.clientY };
        });

        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('resize', () => this.onResize());
    }

    onMouseUp(event) {
        // Check if this was a click (short duration, small movement) or a drag
        const elapsed = Date.now() - this.mouseDownTime;
        const dx = event.clientX - this.mouseDownPos.x;
        const dy = event.clientY - this.mouseDownPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // If dragging (long press or moved too much), don't trigger click
        if (elapsed > 250 || distance > 10) {
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        // Check robots first
        const robotMeshes = [];
        this.robots.forEach(robot => {
            robot.traverse(child => {
                if (child.isMesh) robotMeshes.push(child);
            });
        });

        let intersects = this.raycaster.intersectObjects(robotMeshes, false);
        if (intersects.length > 0) {
            let obj = intersects[0].object;
            while (obj.parent && !obj.userData.sessionId) {
                obj = obj.parent;
            }
            if (obj.userData.sessionId && this.onSessionClick) {
                this.onSessionClick(obj.userData.sessionId);
                return;
            }
        }

        // Check parcels
        const parcelMeshes = Array.from(this.parcels.values());
        intersects = this.raycaster.intersectObjects(parcelMeshes, true);
        if (intersects.length > 0) {
            let obj = intersects[0].object;
            while (obj.parent && !obj.userData.sessionId) {
                obj = obj.parent;
            }
            if (obj.userData.sessionId && this.onSessionClick) {
                this.onSessionClick(obj.userData.sessionId);
                return;
            }
        }

        // Check empty parcels
        const emptyMeshes = Array.from(this.emptyParcels.values());
        intersects = this.raycaster.intersectObjects(emptyMeshes, false);
        if (intersects.length > 0) {
            const parcel = intersects[0].object;
            if (parcel.userData.isEmpty && this.onCreateSession) {
                const { q, r } = parcel.userData;
                this.onCreateSession(q, r);
            }
        }
    }

    onMouseMove(event) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        // Reset previous hover
        if (this.hoveredParcel) {
            this.hoveredParcel.material.opacity = 0.3;
            if (this.hoveredParcel.userData.plusGroup) {
                this.hoveredParcel.userData.plusGroup.userData.plusMaterial.opacity = 0;
            }
            this.hoveredParcel = null;
        }

        // Check empty parcels hover
        const emptyMeshes = Array.from(this.emptyParcels.values());
        const intersects = this.raycaster.intersectObjects(emptyMeshes, false);

        if (intersects.length > 0) {
            const parcel = intersects[0].object;
            if (parcel.userData.isEmpty) {
                parcel.material.opacity = 0.7;
                if (parcel.userData.plusGroup) {
                    parcel.userData.plusGroup.userData.plusMaterial.opacity = 1;
                }
                this.hoveredParcel = parcel;
                this.canvas.style.cursor = 'pointer';
            }
        } else {
            // Check robots/parcels for pointer
            const robotMeshes = [];
            this.robots.forEach(robot => {
                robot.traverse(child => {
                    if (child.isMesh) robotMeshes.push(child);
                });
            });

            const robotIntersects = this.raycaster.intersectObjects(robotMeshes, false);
            if (robotIntersects.length > 0) {
                this.canvas.style.cursor = 'pointer';
            } else {
                this.canvas.style.cursor = 'grab';
            }
        }

        // Tooltip
        const tooltip = document.getElementById('session-tooltip');

        // Check if hovering a robot
        const allRobotMeshes = [];
        this.robots.forEach(robot => {
            robot.traverse(child => {
                if (child.isMesh) {
                    child.userData.parentRobot = robot;
                    allRobotMeshes.push(child);
                }
            });
        });

        const robotHits = this.raycaster.intersectObjects(allRobotMeshes, false);
        if (robotHits.length > 0 && tooltip) {
            const robot = robotHits[0].object.userData.parentRobot ||
                          robotHits[0].object.parent;
            let r = robotHits[0].object;
            while (r && !r.userData.session) r = r.parent;

            if (r && r.userData.session) {
                const session = r.userData.session;
                tooltip.textContent = session.name || session.id;
                tooltip.style.left = `${event.clientX + 15}px`;
                tooltip.style.top = `${event.clientY + 15}px`;
                tooltip.classList.remove('hidden');
                return;
            }
        }

        if (tooltip) {
            tooltip.classList.add('hidden');
        }
    }

    onResize() {
        if (!this.isActive) return;

        const width = window.innerWidth;
        const height = window.innerHeight - 60;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        if (!this.isActive) return;

        const elapsed = this.clock.getElapsedTime();
        const delta = this.clock.getDelta();

        this.controls.update();

        // Animate clouds
        this.clouds.forEach(cloud => {
            cloud.position.x += cloud.userData.speed;
            if (cloud.position.x > 25) {
                cloud.position.x = -25;
            }
        });

        // Animate robots based on status
        this.robots.forEach(robot => {
            const status = robot.userData.status;
            const t = elapsed + robot.userData.animTime;

            if (status === 'thinking') {
                // Bob up and down, rotate slightly
                robot.position.y = this.hexHeight + Math.sin(t * 2) * 0.05;
                robot.rotation.y = Math.sin(t * 1.5) * 0.1;

                // Animate dots
                if (robot.userData.indicator) {
                    robot.userData.indicator.children.forEach((dot, i) => {
                        dot.position.y = Math.sin(t * 3 + i * 0.5) * 0.1;
                    });
                }
            } else if (status === 'executing') {
                // Arms move up and down (working)
                if (robot.userData.leftArm) {
                    robot.userData.leftArm.rotation.x = Math.sin(t * 8) * 0.3;
                    robot.userData.rightArm.rotation.x = Math.sin(t * 8 + Math.PI) * 0.3;
                }

                // Gear rotates
                if (robot.userData.indicator && robot.userData.indicator.children[0]) {
                    robot.userData.indicator.children[0].rotation.z = t * 2;
                }
            } else if (status === 'waiting_input') {
                // Jump animation
                const jumpPhase = t * 4;
                const jump = Math.abs(Math.sin(jumpPhase)) * 0.15;
                robot.position.y = this.hexHeight + jump;

                // Exclamation bobs
                if (robot.userData.indicator) {
                    robot.userData.indicator.position.y = 1.7 + Math.sin(t * 5) * 0.05;
                }
            } else if (status === 'idle') {
                // Gentle breathing
                if (robot.userData.body) {
                    robot.userData.body.scale.y = 1 + Math.sin(t * 1.5) * 0.02;
                }

                // Zzz float
                if (robot.userData.indicator) {
                    robot.userData.indicator.children.forEach((z, i) => {
                        z.position.y = i * 0.15 + Math.sin(t * 2 + i) * 0.05;
                        z.material.opacity = 0.4 + Math.sin(t * 2 + i) * 0.3;
                    });
                }
            } else if (status === 'stopped') {
                // Slumped, no animation
                robot.rotation.z = 0.1;
            }
        });

        this.renderer.render(this.scene, this.camera);
    }

    activate() {
        this.isActive = true;
        this.onResize();
    }

    deactivate() {
        this.isActive = false;
    }

    dispose() {
        this.isActive = false;
        this.controls.dispose();
        this.renderer.dispose();
    }
}
