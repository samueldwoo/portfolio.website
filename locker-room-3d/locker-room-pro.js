/**
 * Professional 3D Locker Room Experience
 * Inspired by Bruno Simon's portfolio - with post-processing, particles, and premium feel
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    camera: {
        fov: 45,
        near: 0.1,
        far: 100,
        position: { x: 0, y: 3.5, z: 0 },
        lookSensitivity: 0.002,
        smoothing: 0.06
    },
    room: {
        radius: 12,
        height: 9,
        segments: 64
    },
    lockers: [
        { id: 'about', label: 'ABOUT', number: '01', angle: -Math.PI / 4, color: 0x4a90d9 },
        { id: 'interests', label: 'INTERESTS', number: '02', angle: Math.PI / 4, color: 0x50c878 },
        { id: 'work', label: 'WORK', number: '03', angle: Math.PI - Math.PI / 4, color: 0xd4a574 },
        { id: 'contact', label: 'CONNECT', number: '04', angle: Math.PI + Math.PI / 4, color: 0x9b6dff }
    ],
    colors: {
        wood: 0x4a3728,
        woodDark: 0x2d1f16,
        woodLight: 0x6b4d3a,
        floor: 0x8b6914,
        floorDark: 0x5c4a0f,
        metal: 0xc0c0c0,
        gold: 0xd4af37,
        brass: 0xb5a642,
        leather: 0x1a1a1a,
        ambient: 0xffeedd
    },
    particles: {
        count: 500,
        size: 0.015
    }
};


// ============================================
// GLOBAL VARIABLES
// ============================================
let scene, camera, renderer, composer;
let lockerMeshes = [];
let raycaster, mouse;
let hoveredLocker = null;
let selectedLocker = null;
let isLoaded = false;
let isStarted = false;
let isZooming = false;

// Camera control
let targetRotation = { x: 0, y: 0 };
let currentRotation = { x: 0, y: 0 };
let isDragging = false;
let previousMouse = { x: 0, y: 0 };

// Animation
let clock;
let dustParticles;
let lightBeams = [];

// Zoom animation
let zoomTarget = null;
let originalCameraPos = null;
let originalCameraRot = null;

// ============================================
// TEXTURE GENERATORS
// ============================================
function createWoodTexture(baseColor, grainColor, scale = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    // Base color
    ctx.fillStyle = '#' + baseColor.toString(16).padStart(6, '0');
    ctx.fillRect(0, 0, 512, 512);
    
    // Wood grain
    ctx.strokeStyle = '#' + grainColor.toString(16).padStart(6, '0');
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.3;
    
    for (let i = 0; i < 100; i++) {
        const y = Math.random() * 512;
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x < 512; x += 10) {
            ctx.lineTo(x, y + Math.sin(x * 0.02) * 3 + (Math.random() - 0.5) * 2);
        }
        ctx.stroke();
    }
    
    // Knots
    ctx.globalAlpha = 0.15;
    for (let i = 0; i < 5; i++) {
        const x = Math.random() * 512;
        const y = Math.random() * 512;
        const r = 10 + Math.random() * 20;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
        gradient.addColorStop(0, '#1a0f0a');
        gradient.addColorStop(1, 'transparent');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(scale, scale);
    return texture;
}


function createFloorTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    
    // Hardwood floor planks
    const plankWidth = 128;
    const plankHeight = 1024;
    
    for (let i = 0; i < 8; i++) {
        const hue = 25 + Math.random() * 10;
        const sat = 60 + Math.random() * 20;
        const light = 25 + Math.random() * 15;
        ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
        ctx.fillRect(i * plankWidth, 0, plankWidth - 2, plankHeight);
        
        // Grain lines
        ctx.strokeStyle = `hsl(${hue}, ${sat}%, ${light - 10}%)`;
        ctx.lineWidth = 0.5;
        ctx.globalAlpha = 0.4;
        for (let j = 0; j < 30; j++) {
            const y = Math.random() * plankHeight;
            ctx.beginPath();
            ctx.moveTo(i * plankWidth, y);
            ctx.lineTo((i + 1) * plankWidth - 2, y + (Math.random() - 0.5) * 20);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        
        // Plank gap
        ctx.fillStyle = '#0a0604';
        ctx.fillRect((i + 1) * plankWidth - 2, 0, 2, plankHeight);
    }
    
    // Court lines
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(512, 512, 200, 0, Math.PI * 2);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.arc(512, 512, 60, 0, Math.PI * 2);
    ctx.stroke();
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

function createNormalMap() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#8080ff';
    ctx.fillRect(0, 0, 256, 256);
    
    // Add subtle bumps
    for (let i = 0; i < 50; i++) {
        const x = Math.random() * 256;
        const y = Math.random() * 256;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, 5);
        gradient.addColorStop(0, '#9090ff');
        gradient.addColorStop(1, '#8080ff');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
    }
    
    return new THREE.CanvasTexture(canvas);
}


// ============================================
// INITIALIZATION
// ============================================
function init() {
    clock = new THREE.Clock();
    
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0906);
    scene.fog = new THREE.FogExp2(0x0d0906, 0.025);

    // Camera
    camera = new THREE.PerspectiveCamera(
        CONFIG.camera.fov,
        window.innerWidth / window.innerHeight,
        CONFIG.camera.near,
        CONFIG.camera.far
    );
    camera.position.set(
        CONFIG.camera.position.x,
        CONFIG.camera.position.y,
        CONFIG.camera.position.z
    );
    camera.rotation.order = 'YXZ';

    // Renderer with better settings
    renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById('canvas'),
        antialias: true,
        powerPreference: 'high-performance'
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.physicallyCorrectLights = true;

    // Raycaster
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // Build scene
    createLighting();
    createRoom();
    createLockers();
    createDustParticles();
    createAtmosphere();

    // Events
    setupEventListeners();

    // Start loading simulation
    simulateLoading();

    // Start render loop
    animate();
}


// ============================================
// LIGHTING - Dramatic NBA facility style
// ============================================
function createLighting() {
    // Very subtle ambient
    const ambient = new THREE.AmbientLight(0xffeedd, 0.15);
    scene.add(ambient);

    // Hemisphere light for natural feel
    const hemi = new THREE.HemisphereLight(0xffeedd, 0x080808, 0.3);
    scene.add(hemi);

    // Central dramatic spotlight
    const centerSpot = new THREE.SpotLight(0xfff5e0, 3);
    centerSpot.position.set(0, CONFIG.room.height - 0.5, 0);
    centerSpot.angle = Math.PI / 2.5;
    centerSpot.penumbra = 0.8;
    centerSpot.decay = 1.5;
    centerSpot.distance = 25;
    centerSpot.castShadow = true;
    centerSpot.shadow.mapSize.width = 2048;
    centerSpot.shadow.mapSize.height = 2048;
    centerSpot.shadow.camera.near = 1;
    centerSpot.shadow.camera.far = 25;
    centerSpot.shadow.bias = -0.0001;
    scene.add(centerSpot);

    // Individual locker spotlights - dramatic downlighting
    CONFIG.lockers.forEach((locker) => {
        const x = Math.cos(locker.angle) * (CONFIG.room.radius - 2);
        const z = Math.sin(locker.angle) * (CONFIG.room.radius - 2);

        // Main spotlight
        const spotlight = new THREE.SpotLight(0xfff8f0, 2.5);
        spotlight.position.set(x * 0.8, CONFIG.room.height - 0.5, z * 0.8);
        spotlight.target.position.set(x, 0, z);
        spotlight.angle = Math.PI / 6;
        spotlight.penumbra = 0.7;
        spotlight.decay = 2;
        spotlight.distance = 15;
        spotlight.castShadow = true;
        spotlight.shadow.mapSize.width = 1024;
        spotlight.shadow.mapSize.height = 1024;
        spotlight.shadow.bias = -0.0001;
        scene.add(spotlight);
        scene.add(spotlight.target);

        // Accent colored light
        const accentLight = new THREE.PointLight(locker.color, 0.3, 5);
        accentLight.position.set(x, 2, z);
        scene.add(accentLight);
    });

    // Rim lights for depth
    const rimPositions = [
        { x: 8, z: 8 }, { x: -8, z: 8 }, { x: 8, z: -8 }, { x: -8, z: -8 }
    ];
    rimPositions.forEach(pos => {
        const rim = new THREE.PointLight(0xffd9b3, 0.15, 12);
        rim.position.set(pos.x, 4, pos.z);
        scene.add(rim);
    });
}


// ============================================
// ROOM GEOMETRY - Premium NBA facility
// ============================================
function createRoom() {
    // Floor - premium hardwood
    const floorTexture = createFloorTexture();
    const floorGeometry = new THREE.CircleGeometry(CONFIG.room.radius + 3, 64);
    const floorMaterial = new THREE.MeshStandardMaterial({
        map: floorTexture,
        roughness: 0.4,
        metalness: 0.1,
        envMapIntensity: 0.5
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Reflective floor overlay for that polished look
    const reflectGeometry = new THREE.CircleGeometry(CONFIG.room.radius + 3, 64);
    const reflectMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        metalness: 0.1,
        roughness: 0.2,
        transparent: true,
        opacity: 0.05,
        envMapIntensity: 1
    });
    const reflect = new THREE.Mesh(reflectGeometry, reflectMaterial);
    reflect.rotation.x = -Math.PI / 2;
    reflect.position.y = 0.001;
    scene.add(reflect);

    // Center court logo area
    createCenterCourt();

    // Ceiling - dark with recessed lighting feel
    const ceilingGeometry = new THREE.CircleGeometry(CONFIG.room.radius + 3, 64);
    const ceilingMaterial = new THREE.MeshStandardMaterial({
        color: 0x0a0705,
        roughness: 0.95,
        metalness: 0
    });
    const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = CONFIG.room.height;
    scene.add(ceiling);

    // Walls - rich wood paneling
    createWalls();
    
    // Architectural details
    createMoldings();
}

function createCenterCourt() {
    // Main circle
    const circleGeometry = new THREE.RingGeometry(2.5, 3, 64);
    const circleMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.3,
        metalness: 0.1,
        emissive: 0xffffff,
        emissiveIntensity: 0.05
    });
    const circle = new THREE.Mesh(circleGeometry, circleMaterial);
    circle.rotation.x = -Math.PI / 2;
    circle.position.y = 0.005;
    scene.add(circle);

    // Inner circle
    const innerGeometry = new THREE.RingGeometry(0.8, 1, 64);
    const inner = new THREE.Mesh(innerGeometry, circleMaterial);
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.005;
    scene.add(inner);

    // Center fill - team color
    const centerGeometry = new THREE.CircleGeometry(0.8, 64);
    const centerMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.gold,
        roughness: 0.4,
        metalness: 0.3,
        emissive: CONFIG.colors.gold,
        emissiveIntensity: 0.1
    });
    const center = new THREE.Mesh(centerGeometry, centerMaterial);
    center.rotation.x = -Math.PI / 2;
    center.position.y = 0.006;
    scene.add(center);
}


function createWalls() {
    const woodTexture = createWoodTexture(CONFIG.colors.wood, CONFIG.colors.woodDark, 4);
    const normalMap = createNormalMap();
    
    // Main curved wall
    const wallGeometry = new THREE.CylinderGeometry(
        CONFIG.room.radius + 1.5,
        CONFIG.room.radius + 1.5,
        CONFIG.room.height,
        64, 1, true
    );
    const wallMaterial = new THREE.MeshStandardMaterial({
        map: woodTexture,
        normalMap: normalMap,
        normalScale: new THREE.Vector2(0.3, 0.3),
        roughness: 0.6,
        metalness: 0.05,
        side: THREE.BackSide
    });
    const walls = new THREE.Mesh(wallGeometry, wallMaterial);
    walls.position.y = CONFIG.room.height / 2;
    walls.receiveShadow = true;
    scene.add(walls);

    // Wainscoting - lower wall detail
    const wainscotGeometry = new THREE.CylinderGeometry(
        CONFIG.room.radius + 1.3,
        CONFIG.room.radius + 1.3,
        3, 64, 1, true
    );
    const wainscotMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.woodDark,
        roughness: 0.5,
        metalness: 0.05,
        side: THREE.BackSide
    });
    const wainscot = new THREE.Mesh(wainscotGeometry, wainscotMaterial);
    wainscot.position.y = 1.5;
    scene.add(wainscot);
}

function createMoldings() {
    const moldingMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.woodDark,
        roughness: 0.4,
        metalness: 0.1
    });

    // Crown molding
    const crownGeometry = new THREE.TorusGeometry(CONFIG.room.radius + 1.4, 0.15, 8, 64);
    const crown = new THREE.Mesh(crownGeometry, moldingMaterial);
    crown.rotation.x = Math.PI / 2;
    crown.position.y = CONFIG.room.height - 0.1;
    scene.add(crown);

    // Base molding
    const baseGeometry = new THREE.TorusGeometry(CONFIG.room.radius + 1.4, 0.1, 8, 64);
    const base = new THREE.Mesh(baseGeometry, moldingMaterial);
    base.rotation.x = Math.PI / 2;
    base.position.y = 0.1;
    scene.add(base);

    // Chair rail
    const railGeometry = new THREE.TorusGeometry(CONFIG.room.radius + 1.35, 0.05, 8, 64);
    const rail = new THREE.Mesh(railGeometry, moldingMaterial);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = 3;
    scene.add(rail);
}


// ============================================
// LOCKERS - Premium NBA style
// ============================================
function createLockers() {
    CONFIG.lockers.forEach((config, index) => {
        const locker = createLocker(config);
        
        const x = Math.cos(config.angle) * (CONFIG.room.radius - 1.5);
        const z = Math.sin(config.angle) * (CONFIG.room.radius - 1.5);
        
        locker.position.set(x, 0, z);
        locker.rotation.y = -config.angle + Math.PI / 2;
        
        locker.userData = {
            id: config.id,
            label: config.label,
            number: config.number,
            color: config.color,
            panelId: config.id + 'Panel',
            originalY: 0
        };
        
        lockerMeshes.push(locker);
        scene.add(locker);
    });
}

function createLocker(config) {
    const group = new THREE.Group();
    
    const woodTexture = createWoodTexture(CONFIG.colors.wood, CONFIG.colors.woodLight, 2);

    // Main cabinet - rich mahogany style
    const cabinetMaterial = new THREE.MeshStandardMaterial({
        map: woodTexture,
        roughness: 0.35,
        metalness: 0.05
    });

    // Back panel
    const backGeometry = new THREE.BoxGeometry(3.5, 7, 0.2);
    const back = new THREE.Mesh(backGeometry, cabinetMaterial);
    back.position.set(0, 3.5, -0.4);
    back.castShadow = true;
    back.receiveShadow = true;
    group.add(back);

    // Side panels
    const sideMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.wood,
        roughness: 0.4,
        metalness: 0.05
    });
    
    [-1, 1].forEach(side => {
        const sideGeometry = new THREE.BoxGeometry(0.15, 7, 1.2);
        const sidePanel = new THREE.Mesh(sideGeometry, sideMaterial);
        sidePanel.position.set(side * 1.75, 3.5, 0.2);
        sidePanel.castShadow = true;
        group.add(sidePanel);
    });

    // Top panel with crown detail
    const topGeometry = new THREE.BoxGeometry(3.8, 0.2, 1.4);
    const top = new THREE.Mesh(topGeometry, cabinetMaterial);
    top.position.set(0, 7.1, 0.2);
    top.castShadow = true;
    group.add(top);

    // Crown molding
    const crownGeometry = new THREE.BoxGeometry(4, 0.15, 1.5);
    const crownMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.woodDark,
        roughness: 0.3,
        metalness: 0.1
    });
    const crown = new THREE.Mesh(crownGeometry, crownMaterial);
    crown.position.set(0, 7.25, 0.2);
    group.add(crown);

    // Base
    const baseGeometry = new THREE.BoxGeometry(3.8, 0.3, 1.4);
    const base = new THREE.Mesh(baseGeometry, cabinetMaterial);
    base.position.set(0, 0.15, 0.2);
    base.castShadow = true;
    group.add(base);


    // Interior - darker
    const interiorMaterial = new THREE.MeshStandardMaterial({
        color: 0x1a1410,
        roughness: 0.8,
        metalness: 0
    });
    
    const interiorGeometry = new THREE.BoxGeometry(3.2, 6.5, 0.8);
    const interior = new THREE.Mesh(interiorGeometry, interiorMaterial);
    interior.position.set(0, 3.5, 0.1);
    group.add(interior);

    // Shelf
    const shelfGeometry = new THREE.BoxGeometry(3.2, 0.08, 0.9);
    const shelf = new THREE.Mesh(shelfGeometry, sideMaterial);
    shelf.position.set(0, 5.5, 0.3);
    shelf.castShadow = true;
    group.add(shelf);

    // Hanging rod
    const rodMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.brass,
        roughness: 0.2,
        metalness: 0.9
    });
    const rodGeometry = new THREE.CylinderGeometry(0.03, 0.03, 3, 16);
    const rod = new THREE.Mesh(rodGeometry, rodMaterial);
    rod.rotation.z = Math.PI / 2;
    rod.position.set(0, 4.8, 0.3);
    group.add(rod);

    // Jersey on hanger
    createJersey(group, config.color);

    // Name plate - brass
    const plateMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.brass,
        roughness: 0.2,
        metalness: 0.85,
        emissive: CONFIG.colors.gold,
        emissiveIntensity: 0.05
    });
    
    const plateGeometry = new THREE.BoxGeometry(1.2, 0.4, 0.05);
    const plate = new THREE.Mesh(plateGeometry, plateMaterial);
    plate.position.set(0, 6.5, 0.85);
    plate.castShadow = true;
    group.add(plate);

    // Number plate
    const numPlateGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.03);
    const numPlate = new THREE.Mesh(numPlateGeometry, plateMaterial);
    numPlate.position.set(0, 5.8, 0.85);
    group.add(numPlate);

    // LED accent strip
    const ledMaterial = new THREE.MeshStandardMaterial({
        color: config.color,
        emissive: config.color,
        emissiveIntensity: 1,
        transparent: true,
        opacity: 0.9
    });
    
    const ledGeometry = new THREE.BoxGeometry(3.2, 0.02, 0.02);
    const led = new THREE.Mesh(ledGeometry, ledMaterial);
    led.position.set(0, 7, 0.8);
    group.add(led);

    // Bench
    createBench(group);

    // Shoes
    createShoes(group);

    // Glow mesh for hover
    const glowGeometry = new THREE.BoxGeometry(3.6, 7.2, 1.3);
    const glowMaterial = new THREE.MeshBasicMaterial({
        color: config.color,
        transparent: true,
        opacity: 0,
        side: THREE.BackSide
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.position.set(0, 3.5, 0.2);
    glow.name = 'glow';
    group.add(glow);

    return group;
}


function createJersey(group, color) {
    // Simplified jersey shape
    const jerseyMaterial = new THREE.MeshStandardMaterial({
        color: color,
        roughness: 0.8,
        metalness: 0
    });

    // Body
    const bodyGeometry = new THREE.BoxGeometry(1.2, 1.8, 0.15);
    const body = new THREE.Mesh(bodyGeometry, jerseyMaterial);
    body.position.set(0, 3.8, 0.4);
    body.castShadow = true;
    group.add(body);

    // Sleeves
    [-1, 1].forEach(side => {
        const sleeveGeometry = new THREE.BoxGeometry(0.4, 0.6, 0.12);
        const sleeve = new THREE.Mesh(sleeveGeometry, jerseyMaterial);
        sleeve.position.set(side * 0.75, 4.4, 0.4);
        sleeve.rotation.z = side * 0.3;
        group.add(sleeve);
    });

    // Hanger
    const hangerMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.wood,
        roughness: 0.5,
        metalness: 0.1
    });
    const hangerGeometry = new THREE.BoxGeometry(1.4, 0.08, 0.08);
    const hanger = new THREE.Mesh(hangerGeometry, hangerMaterial);
    hanger.position.set(0, 4.75, 0.4);
    group.add(hanger);

    // Hook
    const hookGeometry = new THREE.TorusGeometry(0.08, 0.02, 8, 16, Math.PI);
    const hookMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.metal,
        roughness: 0.3,
        metalness: 0.9
    });
    const hook = new THREE.Mesh(hookGeometry, hookMaterial);
    hook.position.set(0, 4.8, 0.4);
    hook.rotation.x = Math.PI / 2;
    group.add(hook);
}

function createBench(group) {
    // Leather bench
    const benchMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.leather,
        roughness: 0.6,
        metalness: 0.1
    });
    
    // Seat
    const seatGeometry = new THREE.BoxGeometry(3, 0.2, 1.2);
    const seat = new THREE.Mesh(seatGeometry, benchMaterial);
    seat.position.set(0, 0.6, 1.4);
    seat.castShadow = true;
    seat.receiveShadow = true;
    group.add(seat);

    // Cushion detail
    const cushionGeometry = new THREE.BoxGeometry(2.8, 0.15, 1);
    const cushionMaterial = new THREE.MeshStandardMaterial({
        color: 0x252525,
        roughness: 0.7,
        metalness: 0
    });
    const cushion = new THREE.Mesh(cushionGeometry, cushionMaterial);
    cushion.position.set(0, 0.72, 1.4);
    group.add(cushion);

    // Metal legs
    const legMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.metal,
        roughness: 0.3,
        metalness: 0.9
    });
    
    [[-1.2, 0.8], [-1.2, 2], [1.2, 0.8], [1.2, 2]].forEach(([x, z]) => {
        const legGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.5, 12);
        const leg = new THREE.Mesh(legGeometry, legMaterial);
        leg.position.set(x, 0.35, z);
        leg.castShadow = true;
        group.add(leg);
    });
}

function createShoes(group) {
    const shoeMaterial = new THREE.MeshStandardMaterial({
        color: 0x1a1a1a,
        roughness: 0.7,
        metalness: 0.1
    });

    [-0.5, 0.5].forEach((x, i) => {
        // Simplified shoe shape
        const shoeGeometry = new THREE.BoxGeometry(0.35, 0.2, 0.8);
        const shoe = new THREE.Mesh(shoeGeometry, shoeMaterial);
        shoe.position.set(x, 0.1, 1.8 + i * 0.1);
        shoe.rotation.y = (i - 0.5) * 0.2;
        shoe.castShadow = true;
        group.add(shoe);
    });
}


// ============================================
// ATMOSPHERE - Dust particles and ambiance
// ============================================
function createDustParticles() {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(CONFIG.particles.count * 3);
    const velocities = new Float32Array(CONFIG.particles.count * 3);
    
    for (let i = 0; i < CONFIG.particles.count; i++) {
        const i3 = i * 3;
        // Spread particles throughout the room
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * CONFIG.room.radius;
        positions[i3] = Math.cos(angle) * radius;
        positions[i3 + 1] = Math.random() * CONFIG.room.height;
        positions[i3 + 2] = Math.sin(angle) * radius;
        
        velocities[i3] = (Math.random() - 0.5) * 0.01;
        velocities[i3 + 1] = (Math.random() - 0.5) * 0.005;
        velocities[i3 + 2] = (Math.random() - 0.5) * 0.01;
    }
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.userData.velocities = velocities;
    
    const material = new THREE.PointsMaterial({
        color: 0xffeedd,
        size: CONFIG.particles.size,
        transparent: true,
        opacity: 0.4,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending
    });
    
    dustParticles = new THREE.Points(geometry, material);
    scene.add(dustParticles);
}

function createAtmosphere() {
    // Light beam cones (volumetric light effect)
    CONFIG.lockers.forEach((locker) => {
        const x = Math.cos(locker.angle) * (CONFIG.room.radius - 2);
        const z = Math.sin(locker.angle) * (CONFIG.room.radius - 2);
        
        const beamGeometry = new THREE.ConeGeometry(1.5, 6, 32, 1, true);
        const beamMaterial = new THREE.MeshBasicMaterial({
            color: 0xfff8f0,
            transparent: true,
            opacity: 0.03,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending
        });
        const beam = new THREE.Mesh(beamGeometry, beamMaterial);
        beam.position.set(x * 0.8, CONFIG.room.height - 3, z * 0.8);
        beam.rotation.x = Math.PI;
        lightBeams.push(beam);
        scene.add(beam);
    });

    // Ceiling light fixtures
    CONFIG.lockers.forEach((locker) => {
        const x = Math.cos(locker.angle) * (CONFIG.room.radius - 2);
        const z = Math.sin(locker.angle) * (CONFIG.room.radius - 2);
        
        // Fixture housing
        const fixtureGeometry = new THREE.CylinderGeometry(0.4, 0.5, 0.3, 16);
        const fixtureMaterial = new THREE.MeshStandardMaterial({
            color: 0x1a1a1a,
            roughness: 0.5,
            metalness: 0.8
        });
        const fixture = new THREE.Mesh(fixtureGeometry, fixtureMaterial);
        fixture.position.set(x * 0.8, CONFIG.room.height - 0.15, z * 0.8);
        scene.add(fixture);

        // Light bulb glow
        const glowGeometry = new THREE.SphereGeometry(0.15, 16, 16);
        const glowMaterial = new THREE.MeshBasicMaterial({
            color: 0xfff5e0,
            transparent: true,
            opacity: 0.8
        });
        const glowBulb = new THREE.Mesh(glowGeometry, glowMaterial);
        glowBulb.position.set(x * 0.8, CONFIG.room.height - 0.35, z * 0.8);
        scene.add(glowBulb);
    });
}


// ============================================
// EVENT LISTENERS
// ============================================
function setupEventListeners() {
    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKeyDown);
    
    document.getElementById('startBtn').addEventListener('click', startExperience);
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onMouseMove(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    if (isDragging && isStarted && !isZooming) {
        const deltaX = event.clientX - previousMouse.x;
        const deltaY = event.clientY - previousMouse.y;
        
        targetRotation.y -= deltaX * CONFIG.camera.lookSensitivity;
        targetRotation.x -= deltaY * CONFIG.camera.lookSensitivity;
        targetRotation.x = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, targetRotation.x));
        
        previousMouse.x = event.clientX;
        previousMouse.y = event.clientY;
    }

    if (isStarted && !isZooming) {
        updateHover(event);
    }
}

function onMouseDown(event) {
    if (event.target.closest('.panel')) return;
    isDragging = true;
    previousMouse.x = event.clientX;
    previousMouse.y = event.clientY;
}

function onMouseUp() {
    isDragging = false;
}

function onClick(event) {
    if (!isStarted || isZooming) return;
    if (event.target.closest('.panel')) return;
    
    if (hoveredLocker) {
        zoomToLocker(hoveredLocker);
    }
}

function onKeyDown(event) {
    if (event.key === 'Escape') {
        if (selectedLocker) {
            zoomOut();
        }
        closePanel();
    }
}


// ============================================
// HOVER DETECTION
// ============================================
function updateHover(event) {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(lockerMeshes, true);

    const label = document.getElementById('lockerLabel');
    const labelTitle = document.getElementById('labelTitle');

    // Reset previous hover
    if (hoveredLocker && hoveredLocker !== selectedLocker) {
        const glow = hoveredLocker.getObjectByName('glow');
        if (glow) glow.material.opacity = 0;
    }

    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while (obj.parent && !obj.userData.id) {
            obj = obj.parent;
        }

        if (obj.userData.id) {
            hoveredLocker = obj;
            
            if (obj !== selectedLocker) {
                const glow = obj.getObjectByName('glow');
                if (glow) glow.material.opacity = 0.12;
            }

            label.style.left = event.clientX + 20 + 'px';
            label.style.top = event.clientY + 20 + 'px';
            labelTitle.textContent = obj.userData.label;
            label.classList.add('visible');

            document.body.style.cursor = 'pointer';
        }
    } else {
        hoveredLocker = null;
        label.classList.remove('visible');
        document.body.style.cursor = 'default';
    }
}

// ============================================
// ZOOM ANIMATION
// ============================================
function zoomToLocker(locker) {
    if (isZooming) return;
    
    isZooming = true;
    selectedLocker = locker;
    
    // Store original camera state
    originalCameraPos = camera.position.clone();
    originalCameraRot = { x: currentRotation.x, y: currentRotation.y };
    
    // Calculate target position (in front of locker)
    const lockerPos = locker.position.clone();
    const direction = lockerPos.clone().normalize();
    const targetPos = lockerPos.clone().sub(direction.multiplyScalar(3));
    targetPos.y = 3.5;
    
    // Calculate target rotation to look at locker
    const targetRotY = Math.atan2(-lockerPos.x, -lockerPos.z);
    
    // Animate
    animateCamera(targetPos, { x: 0, y: targetRotY }, () => {
        openPanel(locker.userData.panelId);
        isZooming = false;
    });
    
    // Highlight selected locker
    const glow = locker.getObjectByName('glow');
    if (glow) glow.material.opacity = 0.2;
    
    // Hide hint
    document.getElementById('hint').classList.remove('visible');
}

function zoomOut() {
    if (isZooming || !selectedLocker) return;
    
    isZooming = true;
    
    // Reset glow
    const glow = selectedLocker.getObjectByName('glow');
    if (glow) glow.material.opacity = 0;
    
    selectedLocker = null;
    
    // Animate back
    animateCamera(originalCameraPos, originalCameraRot, () => {
        isZooming = false;
        document.getElementById('hint').classList.add('visible');
    });
}

function animateCamera(targetPos, targetRot, callback) {
    const startPos = camera.position.clone();
    const startRot = { x: currentRotation.x, y: currentRotation.y };
    const duration = 1200;
    const startTime = Date.now();
    
    function update() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function (ease out cubic)
        const eased = 1 - Math.pow(1 - progress, 3);
        
        // Interpolate position
        camera.position.lerpVectors(startPos, targetPos, eased);
        
        // Interpolate rotation
        currentRotation.x = startRot.x + (targetRot.x - startRot.x) * eased;
        currentRotation.y = startRot.y + (targetRot.y - startRot.y) * eased;
        targetRotation.x = currentRotation.x;
        targetRotation.y = currentRotation.y;
        
        if (progress < 1) {
            requestAnimationFrame(update);
        } else if (callback) {
            callback();
        }
    }
    
    update();
}


// ============================================
// PANEL MANAGEMENT
// ============================================
function openPanel(panelId) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.classList.add('active');
    }
}

function closePanel() {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    if (selectedLocker) {
        zoomOut();
    }
}

window.closePanel = closePanel;

// ============================================
// LOADING & START
// ============================================
function simulateLoading() {
    const loadingBar = document.getElementById('loadingBar');
    const startBtn = document.getElementById('startBtn');
    let progress = 0;

    const interval = setInterval(() => {
        progress += Math.random() * 12;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            isLoaded = true;
            startBtn.classList.add('visible');
        }
        loadingBar.style.width = progress + '%';
    }, 80);
}

function startExperience() {
    if (!isLoaded) return;
    
    isStarted = true;
    document.getElementById('loading').classList.add('hidden');
    
    setTimeout(() => {
        document.getElementById('title').classList.add('visible');
        document.getElementById('hint').classList.add('visible');
    }, 500);
}

// ============================================
// ANIMATION LOOP
// ============================================
function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const time = clock.getElapsedTime();

    // Smooth camera rotation (only when not zooming)
    if (!isZooming) {
        currentRotation.x += (targetRotation.x - currentRotation.x) * CONFIG.camera.smoothing;
        currentRotation.y += (targetRotation.y - currentRotation.y) * CONFIG.camera.smoothing;
    }

    camera.rotation.x = currentRotation.x;
    camera.rotation.y = currentRotation.y;

    // Animate dust particles
    if (dustParticles) {
        const positions = dustParticles.geometry.attributes.position.array;
        const velocities = dustParticles.geometry.userData.velocities;
        
        for (let i = 0; i < CONFIG.particles.count; i++) {
            const i3 = i * 3;
            
            positions[i3] += velocities[i3] + Math.sin(time + i) * 0.002;
            positions[i3 + 1] += velocities[i3 + 1] + Math.sin(time * 0.5 + i) * 0.001;
            positions[i3 + 2] += velocities[i3 + 2] + Math.cos(time + i) * 0.002;
            
            // Wrap around
            if (Math.abs(positions[i3]) > CONFIG.room.radius) positions[i3] *= -0.9;
            if (positions[i3 + 1] > CONFIG.room.height) positions[i3 + 1] = 0;
            if (positions[i3 + 1] < 0) positions[i3 + 1] = CONFIG.room.height;
            if (Math.abs(positions[i3 + 2]) > CONFIG.room.radius) positions[i3 + 2] *= -0.9;
        }
        
        dustParticles.geometry.attributes.position.needsUpdate = true;
    }

    // Subtle locker breathing animation
    lockerMeshes.forEach((locker, i) => {
        if (locker !== selectedLocker) {
            locker.position.y = locker.userData.originalY + Math.sin(time * 0.3 + i * 0.5) * 0.008;
        }
    });

    // Animate light beams
    lightBeams.forEach((beam, i) => {
        beam.material.opacity = 0.02 + Math.sin(time * 0.5 + i) * 0.01;
    });

    renderer.render(scene, camera);
}

// ============================================
// START
// ============================================
init();
console.log('🏀 Professional Locker Room Experience loaded');
