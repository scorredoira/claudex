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

        // Camera state callbacks (set by app.js)
        this.onSaveCamera = null;
        this.getInitialCamera = null;

        // Empty islands callbacks (set by app.js)
        this.onSaveEmptyIslands = null;
        this.getEmptyIslands = null;

        // Claude state callback (set by app.js)
        this.fetchClaudeState = null;
        this.claudeStateCache = new Map(); // sessionId -> { data, timestamp }

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

        // Restore camera position from localStorage
        this.restoreCameraPosition();

        // Save camera position on change
        this.controls.addEventListener('end', () => this.saveCameraPosition());

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

        // Radial menu
        this.radialMenu = document.getElementById('radial-menu');
        this.radialSessionId = null;
        this.setupRadialMenu();

        // Pending session
        this.pendingSession = null;
        this.setupPendingSession();

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

        // Position in hex grid
        const pos = this.hexToWorld(q, r);
        group.position.set(pos.x, 0, pos.z);

        group.userData = { q, r, sessionId: session?.id, type: 'parcel' };

        // Name label on the tile (after userData is set)
        if (session) {
            const label = this.createTileLabel(session.name || session.id);
            label.position.set(0, this.hexHeight + 0.15, this.hexSize * 0.5);
            label.visible = false; // Hidden by default, show with Control key
            group.add(label);
            group.userData.label = label;
        }

        return group;
    }

    createTileLabel(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 160;
        const ctx = canvas.getContext('2d');

        // Truncate text if too long
        let displayText = text;
        if (displayText.length > 14) {
            displayText = displayText.substring(0, 13) + '…';
        }

        // Draw text with strong outline for visibility on grass
        ctx.font = 'bold 64px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Dark outline
        ctx.strokeStyle = '#1a3a10';
        ctx.lineWidth = 6;
        ctx.strokeText(displayText, canvas.width / 2, canvas.height / 2);

        // White text
        ctx.fillStyle = '#ffffff';
        ctx.fillText(displayText, canvas.width / 2, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        const planeGeo = new THREE.PlaneGeometry(this.hexSize * 1.6, this.hexSize * 0.5);
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

        // Truncate text if too long
        let displayText = text;
        if (displayText.length > 14) {
            displayText = displayText.substring(0, 13) + '…';
        }

        // Clear and redraw
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = 'bold 64px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Dark outline
        ctx.strokeStyle = '#1a3a10';
        ctx.lineWidth = 6;
        ctx.strokeText(displayText, canvas.width / 2, canvas.height / 2);

        // White text
        ctx.fillStyle = '#ffffff';
        ctx.fillText(displayText, canvas.width / 2, canvas.height / 2);

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

    // Create robot with customization options
    createRobot(session) {
        const robot = new THREE.Group();
        const status = session.status || 'idle';
        const model = session.robot_model || 'classic';
        const customColor = session.robot_color ? parseInt(session.robot_color.replace('#', ''), 16) : null;
        const accessory = session.robot_accessory || 'none';

        // Build robot based on model
        this.buildRobotModel(robot, model, status, customColor);

        // Add accessory
        this.addRobotAccessory(robot, accessory);

        robot.userData.sessionId = session.id;
        robot.userData.session = session;
        robot.userData.status = status;
        robot.userData.model = model;
        robot.userData.customColor = customColor;
        robot.userData.accessory = accessory;
        robot.userData.animTime = Math.random() * Math.PI * 2;

        // Status indicator above head
        this.createStatusIndicator(robot, status);

        return robot;
    }

    buildRobotModel(robot, model, status, customColor) {
        const statusColor = this.statusColors[status] || this.statusColors.idle;
        const bodyColor = customColor !== null ? customColor : statusColor;

        switch (model) {
            case 'round':
                this.buildRoundRobot(robot, bodyColor);
                break;
            case 'tall':
                this.buildTallRobot(robot, bodyColor);
                break;
            case 'chunky':
                this.buildChunkyRobot(robot, bodyColor);
                break;
            case 'mini':
                this.buildMiniRobot(robot, bodyColor);
                break;
            case 'angular':
                this.buildAngularRobot(robot, bodyColor);
                break;
            default:
                this.buildClassicRobot(robot, bodyColor);
        }
    }

    buildClassicRobot(robot, color) {
        // Body
        const bodyGeo = new THREE.BoxGeometry(0.5, 0.6, 0.4);
        const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.2, flatShading: true });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.6;
        body.castShadow = true;
        robot.add(body);
        robot.userData.body = body;
        robot.userData.bodyMat = bodyMat;

        // Head
        const headGeo = new THREE.BoxGeometry(0.45, 0.35, 0.35);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, flatShading: true });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.1;
        robot.add(head);
        robot.userData.head = head;
        robot.userData.headY = 1.1;

        // Eyes
        const eyeGeo = new THREE.BoxGeometry(0.1, 0.1, 0.05);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.12, 1.12, 0.17);
        robot.add(leftEye);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.12, 1.12, 0.17);
        robot.add(rightEye);

        // Antenna
        this.addAntenna(robot, 1.35, 1.48, color);

        // Arms
        this.addArms(robot, 0.35, 0.55);

        // Legs
        this.addLegs(robot, 0.13, 0.2);
    }

    buildRoundRobot(robot, color) {
        // Round body
        const bodyGeo = new THREE.SphereGeometry(0.35, 12, 8);
        const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.2 });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.55;
        body.castShadow = true;
        robot.add(body);
        robot.userData.body = body;
        robot.userData.bodyMat = bodyMat;

        // Round head
        const headGeo = new THREE.SphereGeometry(0.25, 12, 8);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.05;
        robot.add(head);
        robot.userData.head = head;
        robot.userData.headY = 1.05;

        // Eyes
        const eyeGeo = new THREE.SphereGeometry(0.06, 8, 6);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.1, 1.08, 0.2);
        robot.add(leftEye);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.1, 1.08, 0.2);
        robot.add(rightEye);

        this.addAntenna(robot, 1.35, 1.48, color);
        this.addArms(robot, 0.38, 0.5);
        this.addLegs(robot, 0.15, 0.15);
    }

    buildTallRobot(robot, color) {
        // Tall body
        const bodyGeo = new THREE.BoxGeometry(0.35, 0.9, 0.3);
        const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.2, flatShading: true });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.65;
        body.castShadow = true;
        robot.add(body);
        robot.userData.body = body;
        robot.userData.bodyMat = bodyMat;

        // Small head
        const headGeo = new THREE.BoxGeometry(0.3, 0.25, 0.25);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, flatShading: true });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.25;
        robot.add(head);
        robot.userData.head = head;
        robot.userData.headY = 1.25;

        // Eyes
        const eyeGeo = new THREE.BoxGeometry(0.06, 0.08, 0.03);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.08, 1.27, 0.12);
        robot.add(leftEye);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.08, 1.27, 0.12);
        robot.add(rightEye);

        this.addAntenna(robot, 1.45, 1.58, color);
        this.addArms(robot, 0.25, 0.6);
        this.addLegs(robot, 0.1, 0.12);
    }

    buildChunkyRobot(robot, color) {
        // Wide body
        const bodyGeo = new THREE.BoxGeometry(0.7, 0.5, 0.5);
        const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.2, flatShading: true });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.5;
        body.castShadow = true;
        robot.add(body);
        robot.userData.body = body;
        robot.userData.bodyMat = bodyMat;

        // Wide head
        const headGeo = new THREE.BoxGeometry(0.55, 0.35, 0.4);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, flatShading: true });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 0.95;
        robot.add(head);
        robot.userData.head = head;
        robot.userData.headY = 0.95;

        // Visor eyes
        const eyeGeo = new THREE.BoxGeometry(0.35, 0.1, 0.05);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
        const visor = new THREE.Mesh(eyeGeo, eyeMat);
        visor.position.set(0, 0.97, 0.2);
        robot.add(visor);

        this.addAntenna(robot, 1.2, 1.33, color);
        this.addArms(robot, 0.45, 0.45);
        this.addLegs(robot, 0.2, 0.18);
    }

    buildMiniRobot(robot, color) {
        // Small round body
        const bodyGeo = new THREE.SphereGeometry(0.25, 10, 8);
        const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.2 });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.4;
        body.castShadow = true;
        robot.add(body);
        robot.userData.body = body;
        robot.userData.bodyMat = bodyMat;

        // Big head (proportionally)
        const headGeo = new THREE.SphereGeometry(0.22, 10, 8);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 0.8;
        robot.add(head);
        robot.userData.head = head;
        robot.userData.headY = 0.8;

        // Big cute eyes
        const eyeGeo = new THREE.SphereGeometry(0.07, 8, 6);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.1, 0.82, 0.17);
        robot.add(leftEye);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.1, 0.82, 0.17);
        robot.add(rightEye);

        this.addAntenna(robot, 1.05, 1.18, color);
        // No arms for mini
        this.addLegs(robot, 0.1, 0.1);
    }

    buildAngularRobot(robot, color) {
        // Angular body (octahedron-ish)
        const bodyGeo = new THREE.ConeGeometry(0.35, 0.7, 6);
        const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.3, flatShading: true });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.55;
        body.rotation.y = Math.PI / 6;
        body.castShadow = true;
        robot.add(body);
        robot.userData.body = body;
        robot.userData.bodyMat = bodyMat;

        // Pyramid head
        const headGeo = new THREE.ConeGeometry(0.2, 0.35, 4);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, flatShading: true });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.1;
        head.rotation.y = Math.PI / 4;
        robot.add(head);
        robot.userData.head = head;
        robot.userData.headY = 1.1;

        // Single eye
        const eyeGeo = new THREE.SphereGeometry(0.08, 8, 6);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.position.set(0, 1.0, 0.15);
        robot.add(eye);

        this.addAntenna(robot, 1.35, 1.48, color);
        // No arms for angular
        this.addLegs(robot, 0.15, 0.15);
    }

    addAntenna(robot, stemY, ballY, color) {
        const antennaGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.2, 6);
        const antennaMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.5 });
        const antenna = new THREE.Mesh(antennaGeo, antennaMat);
        antenna.position.y = stemY;
        robot.add(antenna);

        const ballGeo = new THREE.SphereGeometry(0.06, 8, 6);
        const ballMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 });
        const ball = new THREE.Mesh(ballGeo, ballMat);
        ball.position.y = ballY;
        robot.add(ball);
        robot.userData.antennaBall = ball;
        robot.userData.antennaMat = ballMat;
    }

    addArms(robot, offsetX, posY) {
        const armGeo = new THREE.BoxGeometry(0.12, 0.35, 0.12);
        const armMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.4, metalness: 0.3, flatShading: true });

        const leftArm = new THREE.Mesh(armGeo, armMat);
        leftArm.position.set(-offsetX, posY, 0);
        leftArm.castShadow = true;
        robot.add(leftArm);
        robot.userData.leftArm = leftArm;

        const rightArm = new THREE.Mesh(armGeo, armMat);
        rightArm.position.set(offsetX, posY, 0);
        rightArm.castShadow = true;
        robot.add(rightArm);
        robot.userData.rightArm = rightArm;
    }

    addLegs(robot, offsetX, posY) {
        const legGeo = new THREE.BoxGeometry(0.15, 0.25, 0.15);
        const legMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.5, metalness: 0.2, flatShading: true });

        const leftLeg = new THREE.Mesh(legGeo, legMat);
        leftLeg.position.set(-offsetX, posY, 0);
        leftLeg.castShadow = true;
        robot.add(leftLeg);

        const rightLeg = new THREE.Mesh(legGeo, legMat);
        rightLeg.position.set(offsetX, posY, 0);
        rightLeg.castShadow = true;
        robot.add(rightLeg);
    }

    addRobotAccessory(robot, accessory) {
        const headY = robot.userData.headY || 1.1;

        switch (accessory) {
            case 'hat':
                const hatGeo = new THREE.CylinderGeometry(0.15, 0.2, 0.2, 8);
                const hatMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 });
                const hat = new THREE.Mesh(hatGeo, hatMat);
                hat.position.y = headY + 0.25;
                robot.add(hat);
                robot.userData.accessoryMesh = hat;
                break;

            case 'glasses':
                const glassesMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8 });
                const lensGeo = new THREE.TorusGeometry(0.08, 0.015, 8, 16);
                const leftLens = new THREE.Mesh(lensGeo, glassesMat);
                leftLens.position.set(-0.1, headY, 0.2);
                leftLens.rotation.y = Math.PI / 2;
                robot.add(leftLens);
                const rightLens = new THREE.Mesh(lensGeo, glassesMat);
                rightLens.position.set(0.1, headY, 0.2);
                rightLens.rotation.y = Math.PI / 2;
                robot.add(rightLens);
                const bridgeGeo = new THREE.BoxGeometry(0.08, 0.02, 0.02);
                const bridge = new THREE.Mesh(bridgeGeo, glassesMat);
                bridge.position.set(0, headY, 0.2);
                robot.add(bridge);
                break;

            case 'bowtie':
                const bowMat = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
                const bow1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.03), bowMat);
                bow1.position.set(-0.06, 0.85, 0.22);
                bow1.rotation.z = 0.3;
                robot.add(bow1);
                const bow2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.03), bowMat);
                bow2.position.set(0.06, 0.85, 0.22);
                bow2.rotation.z = -0.3;
                robot.add(bow2);
                const knot = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.04), bowMat);
                knot.position.set(0, 0.85, 0.22);
                robot.add(knot);
                break;

            case 'antenna':
                // Extra antenna
                const ant2Geo = new THREE.CylinderGeometry(0.015, 0.015, 0.25, 6);
                const ant2Mat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.5 });
                const ant2 = new THREE.Mesh(ant2Geo, ant2Mat);
                ant2.position.set(0.15, headY + 0.2, 0);
                ant2.rotation.z = 0.3;
                robot.add(ant2);
                const ball2Geo = new THREE.SphereGeometry(0.04, 6, 4);
                const ball2Mat = new THREE.MeshStandardMaterial({ color: 0x00ff00, emissive: 0x00ff00, emissiveIntensity: 0.5 });
                const ball2 = new THREE.Mesh(ball2Geo, ball2Mat);
                ball2.position.set(0.22, headY + 0.38, 0);
                robot.add(ball2);
                break;
        }
    }

    updateRobotCustomization(sessionId, customization) {
        const robot = this.robots.get(sessionId);
        if (!robot) return;

        // Get current position
        const pos = robot.position.clone();
        const session = robot.userData.session;

        // Update session data
        session.robot_model = customization.model;
        session.robot_color = customization.color;
        session.robot_accessory = customization.accessory;

        // Remove old robot
        this.scene.remove(robot);

        // Create new robot with updated customization
        const newRobot = this.createRobot(session);
        newRobot.position.copy(pos);
        this.scene.add(newRobot);
        this.robots.set(sessionId, newRobot);
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
        const statusColor = this.statusColors[status] || this.statusColors.idle;

        // Only update body color if no custom color is set
        if (!robot.userData.customColor) {
            robot.userData.bodyMat.color.setHex(statusColor);
        }

        // Antenna always uses status color (or custom color if set)
        const antennaColor = robot.userData.customColor || statusColor;
        robot.userData.antennaMat.color.setHex(antennaColor);
        robot.userData.antennaMat.emissive.setHex(antennaColor);

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

        // Collect sessions with and without saved positions
        const withPosition = [];
        const withoutPosition = [];
        const occupiedPositions = new Set();

        sessionsMap.forEach((session, id) => {
            if (session.hex_q !== undefined && session.hex_q !== null &&
                session.hex_r !== undefined && session.hex_r !== null) {
                withPosition.push({ session, id, q: session.hex_q, r: session.hex_r });
                occupiedPositions.add(`${session.hex_q},${session.hex_r}`);
            } else {
                withoutPosition.push({ session, id });
            }
        });

        // Assign spiral positions to sessions without saved positions
        const spiralPositions = this.getSpiralPositions(sessionsMap.size + 10); // Extra buffer
        let spiralIndex = 0;
        withoutPosition.forEach(item => {
            // Find next free spiral position
            while (occupiedPositions.has(`${spiralPositions[spiralIndex].q},${spiralPositions[spiralIndex].r}`)) {
                spiralIndex++;
            }
            const { q, r } = spiralPositions[spiralIndex];
            item.q = q;
            item.r = r;
            occupiedPositions.add(`${q},${r}`);
            spiralIndex++;
        });

        // Create all parcels and robots
        const allSessions = [...withPosition, ...withoutPosition];
        allSessions.forEach(({ session, id, q, r }) => {
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
        });

        // Create empty parcels around occupied ones + load saved empty islands
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

        // Add saved empty islands
        const savedIslands = this.getEmptyIslands ? this.getEmptyIslands() : [];
        savedIslands.forEach(({ q, r }) => {
            const key = `${q},${r}`;
            if (!occupied.has(key)) {
                emptyPositions.add(key);
            }
        });

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

        // Track clicks - attach to controls events
        this.controls.addEventListener('start', () => {
            this.mouseDownTime = Date.now();
            this.hideRadialMenu();
        });

        this.canvas.addEventListener('click', (e) => {
            const elapsed = Date.now() - this.mouseDownTime;
            if (elapsed < 300) {
                e.stopPropagation();
                this.onCanvasClick(e);
            }
        });

        this.canvas.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.onCanvasDoubleClick(e);
        });

        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        window.addEventListener('resize', () => this.onResize());

        // Command key (Meta) shows/hides labels
        // Space resets camera view
        // Only when 3D view is active and no modal is open
        this.labelsVisible = false;
        document.addEventListener('keydown', (e) => {
            // Skip if modal is open (user is typing in terminal)
            const modalOpen = !document.getElementById('modal').classList.contains('hidden');
            if (modalOpen) return;

            if (e.key === 'Meta' && !this.labelsVisible) {
                this.labelsVisible = true;
                this.setLabelsVisible(true);
            }
            if (e.key === ' ' && this.isActive) {
                e.preventDefault();
                this.resetCameraView();
            }
        });
        document.addEventListener('keyup', (e) => {
            // Skip if modal is open
            const modalOpen = !document.getElementById('modal').classList.contains('hidden');
            if (modalOpen) return;

            if (e.key === 'Meta') {
                this.labelsVisible = false;
                this.setLabelsVisible(false);
            }
        });
    }

    setLabelsVisible(visible) {
        this.parcels.forEach(parcel => {
            const label = parcel.userData.label;
            if (label) {
                label.visible = visible;
            }
        });
    }

    resetCameraView() {
        // Calculate center of all parcels
        let centerX = 0, centerZ = 0;
        let count = 0;

        this.parcels.forEach(parcel => {
            centerX += parcel.position.x;
            centerZ += parcel.position.z;
            count++;
        });

        if (count > 0) {
            centerX /= count;
            centerZ /= count;
        }

        // Frontal, slightly elevated view - centered on parcels
        this.camera.position.set(centerX, 10, centerZ + 14);
        this.controls.target.set(centerX, 0.5, centerZ);
        this.controls.update();
        this.saveCameraPosition();
    }

    formatTimeAgo(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffSecs < 60) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
    }

    onCanvasClick(event) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        // Check robots - show radial menu on left click
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
            if (obj.userData.sessionId) {
                this.showRadialMenu(event.clientX, event.clientY, obj.userData.sessionId);
                return;
            }
        }

        // Check parcels - show radial menu on left click
        const parcelMeshes = Array.from(this.parcels.values());
        intersects = this.raycaster.intersectObjects(parcelMeshes, true);
        if (intersects.length > 0) {
            let obj = intersects[0].object;
            while (obj.parent && !obj.userData.sessionId) {
                obj = obj.parent;
            }
            if (obj.userData.sessionId) {
                this.showRadialMenu(event.clientX, event.clientY, obj.userData.sessionId);
                return;
            }
        }

        // Check empty parcels - create session directly
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

    onCanvasDoubleClick(event) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        // Check if clicking on existing parcel, robot, or empty parcel - ignore
        const allMeshes = [
            ...Array.from(this.parcels.values()),
            ...Array.from(this.emptyParcels.values())
        ];
        this.robots.forEach(robot => {
            robot.traverse(child => {
                if (child.isMesh) allMeshes.push(child);
            });
        });

        let intersects = this.raycaster.intersectObjects(allMeshes, true);
        if (intersects.length > 0) {
            return; // Clicked on existing object, don't create island
        }

        // Raycast to ground plane (Y = 0)
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const intersection = new THREE.Vector3();
        this.raycaster.ray.intersectPlane(groundPlane, intersection);

        if (intersection) {
            // Convert world position to hex coordinates
            const { q, r } = this.worldToHex(intersection.x, intersection.z);
            const key = `${q},${r}`;

            // Check if this hex position is already occupied
            const occupied = new Set();
            this.parcels.forEach((_, k) => occupied.add(k));
            this.emptyParcels.forEach((_, k) => occupied.add(k));

            if (!occupied.has(key) && this.onCreateSession) {
                // Create session directly at this position
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

        // Tooltip - don't show if radial menu is active
        const tooltip = document.getElementById('session-tooltip');
        if (this.radialMenu.classList.contains('active')) {
            if (tooltip) tooltip.classList.add('hidden');
            return;
        }

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
                this.showSessionTooltip(session, tooltip, event.clientX, event.clientY);
                return;
            }
        }

        if (tooltip) {
            tooltip.classList.add('hidden');
        }
    }

    async showSessionTooltip(session, tooltip, x, y) {
        const statusLabels = {
            idle: 'Idle',
            thinking: 'Thinking',
            executing: 'Executing',
            waiting_input: 'Waiting',
            stopped: 'Stopped',
            shell: 'Shell'
        };
        const status = statusLabels[session.status] || session.status;
        const lastActive = session.last_input_at || session.updated_at;
        const timeAgo = lastActive ? this.formatTimeAgo(lastActive) : 'Never';

        // Basic tooltip first
        let html = `
            <strong>${session.name || session.id}</strong><br>
            <span style="opacity: 0.7">${status} · ${timeAgo}</span>
        `;

        // Check Claude state cache
        const cacheKey = session.id;
        const cached = this.claudeStateCache.get(cacheKey);
        const now = Date.now();

        // Use cache if less than 5 seconds old
        if (cached && (now - cached.timestamp) < 5000) {
            html = this.buildClaudeTooltip(session, cached.data, status, timeAgo);
        } else if (this.fetchClaudeState) {
            // Fetch in background
            this.fetchClaudeState(session.id).then(claudeState => {
                if (claudeState) {
                    this.claudeStateCache.set(cacheKey, { data: claudeState, timestamp: Date.now() });
                    // Update tooltip if still visible and same session
                    if (!tooltip.classList.contains('hidden')) {
                        tooltip.innerHTML = this.buildClaudeTooltip(session, claudeState, status, timeAgo);
                    }
                }
            }).catch(() => {});
        }

        tooltip.innerHTML = html;
        tooltip.style.left = `${x + 15}px`;
        tooltip.style.top = `${y + 15}px`;
        tooltip.classList.remove('hidden');
    }

    buildClaudeTooltip(session, claudeState, status, timeAgo) {
        let html = `<strong>${session.name || session.id}</strong><br>`;

        // Use Claude state status if available and more specific
        if (claudeState.status && claudeState.status !== 'idle') {
            const claudeStatusLabels = {
                thinking: '🤔 Thinking',
                executing: '⚡ Executing',
                waiting_input: '⏳ Waiting for input',
                idle: 'Idle'
            };
            html += `<span style="opacity: 0.9">${claudeStatusLabels[claudeState.status] || claudeState.status}</span><br>`;

            // Show current tool if executing
            if (claudeState.status === 'executing' && claudeState.currentTool) {
                html += `<span style="opacity: 0.7; font-size: 0.9em">`;
                html += `📦 ${claudeState.currentTool}`;
                if (claudeState.toolTarget) {
                    html += `: <code>${claudeState.toolTarget}</code>`;
                }
                html += `</span><br>`;
            }
        } else {
            html += `<span style="opacity: 0.7">${status} · ${timeAgo}</span><br>`;
        }

        // Directory
        if (claudeState.cwd) {
            const shortPath = claudeState.cwd.split('/').slice(-2).join('/');
            html += `<span style="opacity: 0.6; font-size: 0.85em">📁 ${shortPath}</span><br>`;
        }

        // Model
        if (claudeState.model) {
            const shortModel = claudeState.model.replace('claude-', '').replace('-20251101', '');
            html += `<span style="opacity: 0.6; font-size: 0.85em">🤖 ${shortModel}</span><br>`;
        }

        // Tokens
        if (claudeState.tokensUsed > 0) {
            const tokensK = (claudeState.tokensUsed / 1000).toFixed(1);
            html += `<span style="opacity: 0.6; font-size: 0.85em">📊 ${tokensK}k tokens</span>`;
        }

        return html;
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

        // Update pending session buttons position
        if (this.pendingSession) {
            this.updatePendingButtons();
            // Animate ghost robot
            const ghost = this.pendingSession.robot;
            if (ghost && ghost.children[2]) {
                ghost.children[2].position.y = 1.5 + Math.sin(elapsed * 3) * 0.1;
            }
        }

        // Make labels face camera (billboard effect)
        this.parcels.forEach(parcel => {
            const label = parcel.userData.label;
            if (label) {
                // Get camera direction projected on XZ plane
                const cameraDir = new THREE.Vector3();
                this.camera.getWorldDirection(cameraDir);

                // Calculate angle to face camera
                const angle = Math.atan2(cameraDir.x, cameraDir.z);

                // Tilt the label to face camera (mix of flat and upright)
                label.rotation.set(-Math.PI / 3, angle + Math.PI, 0, 'YXZ');
            }
        });

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

    // Radial menu setup
    setupRadialMenu() {
        // Hide radial menu on click outside
        document.addEventListener('click', (e) => {
            if (!this.radialMenu.contains(e.target)) {
                this.hideRadialMenu();
            }
        });

        // Handle center button click (open session)
        const center = this.radialMenu.querySelector('.radial-menu-center');
        center.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleRadialAction('open', this.radialSessionId);
            this.hideRadialMenu();
        });

        // Handle radial menu actions
        this.radialMenu.querySelectorAll('.radial-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                this.handleRadialAction(action, this.radialSessionId);
                this.hideRadialMenu();
            });
        });
    }

    showRadialMenu(x, y, sessionId) {
        this.radialSessionId = sessionId;
        this.radialMenu.style.left = x + 'px';
        this.radialMenu.style.top = y + 'px';

        // Hide the hover tooltip
        const tooltip = document.getElementById('session-tooltip');
        if (tooltip) tooltip.classList.add('hidden');

        // Populate session info
        const robot = this.robots.get(sessionId);
        if (robot && robot.userData.session) {
            const session = robot.userData.session;
            const statusLabels = {
                idle: 'Idle',
                thinking: 'Thinking',
                executing: 'Executing',
                waiting_input: 'Waiting',
                stopped: 'Stopped',
                shell: 'Shell'
            };
            const status = statusLabels[session.status] || session.status;
            const lastActive = session.last_input_at || session.updated_at;
            const timeAgo = lastActive ? this.formatTimeAgo(lastActive) : 'Never';

            const nameEl = this.radialMenu.querySelector('.radial-info-name');
            const detailsEl = this.radialMenu.querySelector('.radial-info-details');
            if (nameEl) nameEl.textContent = session.name || session.id;
            if (detailsEl) detailsEl.textContent = `${status} · ${timeAgo}`;
        }

        this.radialMenu.classList.add('active');
    }

    hideRadialMenu() {
        this.radialMenu.classList.remove('active');
        this.radialSessionId = null;
    }

    handleRadialAction(action, sessionId) {
        switch (action) {
            case 'open':
                if (this.onSessionClick) this.onSessionClick(sessionId);
                break;
            case 'delete':
                if (this.onDeleteSession) this.onDeleteSession(sessionId);
                break;
            case 'restart':
                if (this.onRestartSession) this.onRestartSession(sessionId);
                break;
            case 'experiment':
                if (this.onExperimentSession) this.onExperimentSession(sessionId);
                break;
            case 'customize':
                if (this.onCustomizeSession) this.onCustomizeSession(sessionId);
                break;
        }
    }

    // Pending session setup (no longer used - sessions create directly)
    setupPendingSession() {
        // No-op: pending session UI was removed
    }

    createPendingSession(q, r) {
        // Remove previous pending if exists
        this.cancelPendingSession();

        // Create ghost parcel
        const group = new THREE.Group();
        const geometry = this.createParcelGeometry();
        const material = new THREE.MeshStandardMaterial({
            color: this.parcelColor,
            roughness: 0.8,
            flatShading: true,
            transparent: true,
            opacity: 0.5
        });

        const parcel = new THREE.Mesh(geometry, material);
        parcel.rotation.x = -Math.PI / 2;
        group.add(parcel);

        // Ghost robot
        const robot = this.createGhostRobot();
        robot.position.y = this.hexHeight;
        group.add(robot);

        const pos = this.hexToWorld(q, r);
        group.position.set(pos.x, 0, pos.z);

        this.scene.add(group);

        this.pendingSession = { q, r, group, robot };

        // Position confirm/cancel buttons
        this.updatePendingButtons();
    }

    createGhostRobot() {
        const robot = new THREE.Group();
        const color = 0xaaaaaa;

        // Body
        const bodyGeo = new THREE.BoxGeometry(0.5, 0.6, 0.4);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: color,
            roughness: 0.3,
            transparent: true,
            opacity: 0.6
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.6;
        robot.add(body);

        // Head
        const headGeo = new THREE.BoxGeometry(0.45, 0.35, 0.35);
        const headMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.3,
            transparent: true,
            opacity: 0.6
        });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.1;
        robot.add(head);

        // Question mark indicator
        const qGeo = new THREE.SphereGeometry(0.15, 8, 6);
        const qMat = new THREE.MeshBasicMaterial({ color: 0x6366f1 });
        const q = new THREE.Mesh(qGeo, qMat);
        q.position.y = 1.5;
        robot.add(q);

        return robot;
    }

    updatePendingButtons() {
        // No-op: pending session UI was removed
    }

    cancelPendingSession() {
        if (this.pendingSession) {
            this.scene.remove(this.pendingSession.group);
            this.pendingSession = null;
        }
    }

    saveCameraPosition() {
        const data = {
            x: this.camera.position.x,
            y: this.camera.position.y,
            z: this.camera.position.z,
            targetX: this.controls.target.x,
            targetY: this.controls.target.y,
            targetZ: this.controls.target.z
        };
        if (this.onSaveCamera) {
            this.onSaveCamera(data);
        }
    }

    restoreCameraPosition() {
        const data = this.getInitialCamera ? this.getInitialCamera() : null;
        if (data && data.x !== undefined) {
            this.camera.position.set(data.x, data.y, data.z);
            this.controls.target.set(data.targetX, data.targetY, data.targetZ);
            this.controls.update();
        }
    }
}
