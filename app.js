  // --- Global Variables & Tone.js Setup ---
  let scene, camera, renderer, composer, bloomPass, foamPlane, foamMaterial; // Added foamPlane, foamMaterial
  let particleSystem, lineMesh;
  const particlesData = [];
  let particleCount = 100; // Reduced for performance with foam
  const NEIGHBOR_RADIUS_SQ = Math.pow(25, 2); // Increased flocking radii
  const SEPARATION_RADIUS_SQ = Math.pow(15, 2);
  const MAX_SPEED = 0.2; const MAX_FORCE = 0.004; // Slightly reduced speeds

  const maxConnections = 4; const connectionDistance = 45; 
  let time = 0;
  let mouse = new THREE.Vector2(-10000, -10000); let mouseWorld = new THREE.Vector3();
  let eventHorizon = { active: false, position: new THREE.Vector3(), screenPos: new THREE.Vector3(), strength: 0, time: 0, maxRadius: 110 };
  
  let navSynth, novaSynth, hoverSynth, ambientDrone, particleClusterSynth;
  let audioInitialized = false;
  let averageParticleEnergy = 0;

  function initAudio() {
      if (audioInitialized) return;
      try {
          Tone.start(); 
          navSynth = new Tone.PluckSynth({ attackNoise:0.1, dampening:7000, resonance:0.9, volume:-22 }).toDestination();
          novaSynth = new Tone.MembraneSynth({ pitchDecay:0.008, octaves:7, oscillator:{type:"fmsine", modulationType:"sawtooth", harmonicity:0.8}, envelope:{attack:0.001,decay:0.5,sustain:0.005,release:1.4}, volume:-8 }).toDestination();
          const novaReverb = new Tone.Reverb(0.9, 4000).toDestination(); 
          const novaPingPong = new Tone.PingPongDelay("4n", 0.4).connect(novaReverb);
          novaSynth.connect(novaPingPong);

          hoverSynth = new Tone.Synth({ oscillator: {type: 'triangle', detune:1500}, envelope: {attack:0.001,decay:0.008,sustain:0,release:0.015}, volume:-48 }).toDestination();
          
          ambientDrone = new Tone.Loop((now) => { 
              if(ambientDrone && Math.random() < 0.2) { 
                  const note = Tone.Midi(Math.random() * 12 + 24).toNote(); // Very low notes
                  ambientDrone.triggerAttackRelease(note, "12m", now, Math.random() * 0.1 + 0.05);
              }
          }, "3m").start(0); // Longer interval
          ambientDrone = new Tone.PolySynth(Tone.FMSynth, {
              harmonicity: 0.8, modulationIndex: 2, detune: 0, oscillator: {type: "pwm", modulationFrequency: 0.05},
              envelope: {attack: 8, decay: 2, sustain: 0.9, release: 10},
              modulation: {type: "sine"},
              modulationEnvelope: {attack: 5, decay: 1, sustain: 0.8, release: 8},
              volume: -55 // Even quieter
          }).toDestination();
          const droneFilter = new Tone.AutoFilter({frequency: "1m", baseFrequency: 50, octaves: 3, depth: 0.3}).toDestination().start();
          ambientDrone.connect(droneFilter);

          audioInitialized = true;
          Tone.Transport.start();
      } catch (e) { console.error("Tone.js init failed:", e); }
  }


  // --- Shader Definitions ---
  // Particle and Line shaders from previous step are good, will be slightly tweaked if needed
  // Foam shaders are new
  const particleVertexShader = `
      attribute float size; attribute vec3 customColor; attribute float energy;
      varying vec3 vColor; varying float vAlpha; varying float vEnergy;
      uniform float time; uniform vec3 eventHorizonPos; uniform float eventHorizonStrength; uniform float eventHorizonTime;
      uniform float scrollFactor; uniform float averageEnergy; 

      void main() {
          vColor = customColor; vEnergy = energy;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          
          float distToHorizon = distance(position, eventHorizonPos);
          float horizonEffect = 0.0; float pullEffect = 0.0;
          if (eventHorizonStrength > 0.0) {
              float horizonRadius = eventHorizonTime * 110.0; // Faster, wider burst
              float waveFront = smoothstep(horizonRadius + 35.0, horizonRadius - 35.0, distToHorizon);
              horizonEffect = waveFront * eventHorizonStrength * 3.0; 
              pullEffect = (1.0 - smoothstep(0.0, horizonRadius * 0.2, distToHorizon)) * eventHorizonStrength * -0.20 * (1.0 - eventHorizonTime * 0.4); 
          }

          float energyPulse = 1.0 + sin(time * (2.8 + scrollFactor * 3.5 + averageEnergy * 2.5) + position.y * 0.06 + energy * 7.0) * (0.7 + energy * 0.9);
          gl_PointSize = (size * (0.3 + energy * 2.5) + horizonEffect * 30.0) * energyPulse * (550.0 / -mvPosition.z); // Increased base size influence
          
          float edgeFade = smoothstep(0.0, 0.08, min(min((position.x + boundingBoxSize*0.5)/boundingBoxSize, (boundingBoxSize*0.5 - position.x)/boundingBoxSize), min((position.y + boundingBoxSize*0.5)/boundingBoxSize, (boundingBoxSize*0.5 - position.y)/boundingBoxSize)));
          vAlpha = edgeFade * (0.25 + energy * 0.75 + horizonEffect * 0.6); // More reactive alpha
          
          vec4 displacedPosition = mvPosition;
          displacedPosition.xyz += normalize(eventHorizonPos - position) * pullEffect * 18.0 * eventHorizonStrength;
          gl_Position = projectionMatrix * displacedPosition;
      }
  `;
  const particleFragmentShader = `
      varying vec3 vColor; varying float vAlpha; varying float vEnergy;
      uniform sampler2D pointTexture; uniform float time; uniform float scrollFactor; uniform float averageEnergy;
      ${document.getElementById('fbm') ? document.getElementById('fbm').textContent : ''} 

      void main() {
          vec2 uv = gl_PointCoord; float dist = length(uv * 2.0 - 1.0);

          float coreSharpness = 0.03 + vEnergy * 0.12; // Even sharper core
          float core = smoothstep(coreSharpness, 0.0, dist);
          float glow = smoothstep(0.6, 0.05, dist) * (0.25 + vEnergy * 0.5 + averageEnergy * 0.25); // More intense glow
          float outerHalo = smoothstep(1.0, 0.3, dist) * 0.3 * (0.3 + scrollFactor + averageEnergy * 0.4); // Wider halo

          float noiseVal = 0.0;
          #ifdef OCTAVES 
              noiseVal = fbm(uv * (2.5 + vEnergy * 6.0) + vec2(time * 0.6, time * -0.35 + uv.x * 0.5)); // More dynamic noise
          #endif
          float unstableCore = smoothstep(0.4, 0.6, noiseVal) * (0.6 + vEnergy * 1.2); // Stronger unstable core
          core = max(core, unstableCore * 0.7);

          vec3 baseColor = vColor + vec3(scrollFactor * 0.4, -scrollFactor * 0.3 + averageEnergy * 0.25, (1.0-scrollFactor) * 0.4 + vEnergy * 0.15);
          vec3 energyColor = mix(baseColor, vec3(1.0, 0.9, 0.7), vEnergy * 0.9); // Shift to incandescent orange/white
          energyColor = mix(energyColor, vec3(0.7, 0.9, 1.0), averageEnergy * 0.6); 

          float interference = sin(dist * 30.0 + time * 7.0 + vEnergy * 15.0) * 0.1 * smoothstep(0.2, 0.7, vEnergy); // More pronounced interference
          gl_FragColor = vec4(energyColor, (core * 1.3 + glow * 1.1 + outerHalo + interference) * vAlpha);
      }
  `;
  const lineVertexShader = `
      attribute float alpha; attribute float energy; 
      varying float vLineAlpha; varying float vEnergy; varying vec3 vWorldPosition;
      void main() {
          vLineAlpha = alpha; vEnergy = energy;
          vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz; // Ensure modelMatrix is applied if lines are not direct children of scene
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
  `;
  const lineFragmentShader = `
      uniform vec3 color; varying float vLineAlpha; varying float vEnergy; varying vec3 vWorldPosition;
      uniform float time; uniform float scrollFactor; uniform float averageEnergy;
      ${document.getElementById('fbm') ? document.getElementById('fbm').textContent : ''}

      void main() {
          float energyFactor = 0.15 + vEnergy * 3.5 + averageEnergy * 1.5; 
          float noiseInputX = vWorldPosition.x * 0.015 + time * -2.0 + vEnergy * 4.0;
          float noiseInputY = vWorldPosition.y * 0.015 + time * 1.0 + vEnergy * 2.0;
          float fbmPulse = 0.0;
          #ifdef OCTAVES 
              fbmPulse = fbm(vec2(noiseInputX, noiseInputY));
          #endif
          fbmPulse = pow(fbmPulse, 3.0) * (0.7 + vEnergy * 2.5); // More dynamic pulse

          vec3 lineColor = color + vec3(scrollFactor * 0.6 + averageEnergy * 0.4, vEnergy * 0.7, (1.0-scrollFactor) * 0.6 + vEnergy * 0.9);
          lineColor = mix(lineColor, vec3(1.0,1.0,0.8), vEnergy * 0.8 + averageEnergy * 0.4); // Brighter, slightly yellowish for high energy

          gl_FragColor = vec4(lineColor, vLineAlpha * energyFactor * (0.1 + fbmPulse * 0.9)); // More impactful alpha
      }
  `;

  function initThreeJS() {
      const canvas = document.getElementById('three-canvas'); // Main particle canvas
      const foamCanvas = document.getElementById('foam-canvas'); // Dedicated foam canvas
      
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 7000); // Even further far plane
      camera.position.z = 180; // Camera further back

      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25)); // Further reduce pixel ratio if needed
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.4; // Adjust exposure for overall brightness

      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.1, 0.5); // strength, radius, threshold - more subtle bloom
      composer.addPass(bloomPass);

      // Quantum Foam Plane
      const foamGeometry = new THREE.PlaneGeometry(window.innerWidth, window.innerHeight, 1, 1); // Simple plane
      foamMaterial = new THREE.ShaderMaterial({
          uniforms: {
              time: { value: 0.0 },
              resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
              baseColorFoam: { value: new THREE.Color(0x010310) }, // Very dark blue base for foam
              averageEnergy: { value: 0.0 },
              mouseScreenPos: { value: new THREE.Vector2(0.5, 0.5) }, // Center initially
              eventHorizonStrength: { value: 0.0 },
              eventHorizonWorldPos: { value: new THREE.Vector3() }, // Will store screenPos.xy and radius .z for foam
              eventHorizonRadius: { value: 0.0 }
          },
          vertexShader: document.getElementById('foamVertexShader').textContent,
          fragmentShader: document.getElementById('foamFragmentShader').textContent,
          transparent: true,
          depthWrite: false // Render behind particles
      });
      foamPlane = new THREE.Mesh(foamGeometry, foamMaterial);
      foamPlane.position.z = -50; // Place it behind the particle system
       // Create a separate scene for the foam plane to render it first (or control render order)
      const foamScene = new THREE.Scene();
      foamScene.add(foamPlane);
      // We will render foamScene first, then the main scene. This requires a custom render loop or careful composer setup.
      // For simplicity now, adding to main scene and relying on z-depth and blending.
      // A more robust solution would use multiple render passes if strict layering is needed without z-fighting.
      scene.add(foamPlane); // Add to main scene for now, ensure particles are in front.


      const pGeometry = new THREE.BufferGeometry();
      const positions = new Float32Array(particleCount * 3);
      const colors = new Float32Array(particleCount * 3);
      const sizes = new Float32Array(particleCount);
      const energies = new Float32Array(particleCount);
      const particleBaseColor = new THREE.Color(0x00ffff); 

      for (let i = 0; i < particleCount; i++) {
          positions[i * 3] = (Math.random() - 0.5) * boundingBoxSize * 2.2; 
          positions[i * 3 + 1] = (Math.random() - 0.5) * boundingBoxSize * 2.2;
          positions[i * 3 + 2] = (Math.random() - 0.5) * boundingBoxSize * 0.3; 

          let c = particleBaseColor.clone();
          c.offsetHSL((Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6); 
          colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
          sizes[i] = Math.random() * 1.0 + 0.5; // Smaller base
          energies[i] = Math.random() * 0.1;

          particlesData.push({
              id: i, 
              position: new THREE.Vector3(positions[i*3], positions[i*3+1], positions[i*3+2]),
              velocity: new THREE.Vector3((Math.random()-0.5)*MAX_SPEED*0.3, (Math.random()-0.5)*MAX_SPEED*0.3, (Math.random()-0.5)*MAX_SPEED*0.1),
              acceleration: new THREE.Vector3(),
              numConnections: 0, energy: energies[i],
              maxSpeed: MAX_SPEED * (Math.random() * 0.3 + 0.85), 
              maxForce: MAX_FORCE * (Math.random() * 0.3 + 0.85)  
          });
      }
      pGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      pGeometry.setAttribute('customColor', new THREE.BufferAttribute(colors, 3));
      pGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
      pGeometry.setAttribute('energy', new THREE.BufferAttribute(energies, 1));

      const pMaterial = new THREE.ShaderMaterial({
          uniforms: { 
              pointTexture: { value: new THREE.TextureLoader().load('https://placehold.co/64x64/FFFFFF/000000.png?text=✧&font=noto') }, 
              time: { value: 0.0 },
              eventHorizonPos: { value: new THREE.Vector3() },
              eventHorizonStrength: { value: 0.0 },
              eventHorizonTime: { value: 0.0 },
              boundingBoxSize: { value: boundingBoxSize },
              scrollFactor: { value: 0.0 },
              averageEnergy: { value: 0.0 }
          },
          vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
          blending: THREE.AdditiveBlending, depthTest: false, transparent: true
      });
      particleSystem = new THREE.Points(pGeometry, pMaterial);
      particleSystem.position.z = 0; // Ensure particles are in front of foam
      scene.add(particleSystem);

      const lineMaterial = new THREE.ShaderMaterial({
          uniforms: { 
              color: { value: new THREE.Color(0x4dc3ff) }, // Slightly different line color
              time: { value: 0.0 },
              scrollFactor: { value: 0.0 },
              averageEnergy: { value: 0.0 }
          },
          vertexShader: lineVertexShader, fragmentShader: lineFragmentShader,
          blending: THREE.AdditiveBlending, depthTest: false, transparent: true
      });
      const lineGeometry = new THREE.BufferGeometry();
      const linePositions = new Float32Array(particleCount * maxConnections * 2 * 3);
      const lineAlphas = new Float32Array(particleCount * maxConnections * 2);
      const lineEnergies = new Float32Array(particleCount * maxConnections * 2);
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));
      lineGeometry.setAttribute('alpha', new THREE.BufferAttribute(lineAlphas, 1).setUsage(THREE.DynamicDrawUsage));
      lineGeometry.setAttribute('energy', new THREE.BufferAttribute(lineEnergies, 1).setUsage(THREE.DynamicDrawUsage));
      lineMesh = new THREE.LineSegments(lineGeometry, lineMaterial);
      lineMesh.position.z = 0; // Ensure lines are also in front of foam
      scene.add(lineMesh);
      
      window.addEventListener('resize', onWindowResize, false);
      document.addEventListener('mousemove', onDocumentMouseMove, false);
      document.addEventListener('mousedown', onDocumentMouseDown, false);
      document.addEventListener('touchstart', onDocumentTouchStart, { passive: false });
      window.addEventListener('scroll', onWindowScroll, false);
      initNeuralTextAnimations(); 
      animate();
  }
  
  function onWindowScroll() { 
       const scrollY = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollFactor = Math.min(1, scrollY / docHeight);
      
      if (particleSystem) particleSystem.material.uniforms.scrollFactor.value = scrollFactor;
      if (lineMesh) lineMesh.material.uniforms.scrollFactor.value = scrollFactor;
      // Foam scroll factor can be added if desired:
      // if (foamMaterial) foamMaterial.uniforms.scrollFactor.value = scrollFactor; 
      if (bloomPass) bloomPass.strength = 0.7 + scrollFactor * 0.9; // Bloom reacts more to scroll
   }
  function onWindowResize() { 
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
      if (foamMaterial) foamMaterial.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
      if (foamPlane) { // Resize foam plane to cover screen
          foamPlane.scale.set(window.innerWidth/2, window.innerHeight/2, 1); // Assuming plane size is 2x2 initially
      }
   }
  function onDocumentMouseMove(event) { 
      mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
      
      // Update mouseScreenPos for foam shader (0-1 range)
      if (foamMaterial) {
          foamMaterial.uniforms.mouseScreenPos.value.set(event.clientX / window.innerWidth, 1.0 - (event.clientY / window.innerHeight));
      }

      const vec = new THREE.Vector3(mouse.x, mouse.y, 0.5);
      vec.unproject(camera);
      const dir = vec.sub(camera.position).normalize();
      const distance = -camera.position.z / dir.z; 
      mouseWorld.copy(camera.position).add(dir.multiplyScalar(distance));

      const cursorContainer = document.getElementById('custom-cursor-container');
      if (cursorContainer) {
          cursorContainer.style.left = `${event.clientX}px`;
          cursorContainer.style.top = `${event.clientY}px`;
          
          const targetElement = event.target.closest('a, button, .project-card, .timeline-item');
          cursorContainer.classList.toggle('pointer', !!targetElement);
          if (targetElement && hoverSynth && audioInitialized && Math.random() < 0.02) { 
             hoverSynth.triggerAttackRelease("E6", "128n", Tone.now() + 0.0005);
          }
      }
  }
  function handleInteractionStart(x, y) { 
      initAudio(); 
      if (novaSynth) novaSynth.triggerAttackRelease("G0", "0.25n", Tone.now() + 0.01); // Deeper, quicker burst

      // World space for particles
      const vecWorld = new THREE.Vector3((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1, 0.5);
      vecWorld.unproject(camera);
      const dirWorld = vecWorld.sub(camera.position).normalize();
      const distanceWorld = -camera.position.z / dirWorld.z;
      eventHorizon.position.copy(camera.position).add(dirWorld.multiplyScalar(distanceWorld));
      
      // Screen space for foam (0-1 range)
      eventHorizon.screenPos.set(x / window.innerWidth, 1.0 - (y / window.innerHeight), 0.05); // x, y, initial radius/strength factor for foam

      eventHorizon.active = true; eventHorizon.strength = 1.0; eventHorizon.time = 0;

      const cursorContainer = document.getElementById('custom-cursor-container');
      if(cursorContainer) cursorContainer.classList.add('clicked');
      setTimeout(() => { if(cursorContainer) cursorContainer.classList.remove('clicked'); }, 700);
  }
  function onDocumentMouseDown(event) { handleInteractionStart(event.clientX, event.clientY); }
  function onDocumentTouchStart(event) {
      if (event.touches.length > 0) {
          event.preventDefault(); 
          handleInteractionStart(event.touches[0].clientX, event.touches[0].clientY);
      }
  }

  function applyForce(particle, force) { particle.acceleration.add(force); }
  function seek(particle, target) { /* ... */ 
      const desired = new THREE.Vector3().subVectors(target, particle.position);
      desired.normalize().multiplyScalar(particle.maxSpeed);
      const steer = new THREE.Vector3().subVectors(desired, particle.velocity);
      steer.clampLength(0, particle.maxForce);
      return steer;
  }
  function separate(particle, particles) { /* ... */ 
      let sum = new THREE.Vector3(); let count = 0;
      for (const other of particles) {
          if (particle.id === other.id) continue;
          const dSq = particle.position.distanceToSquared(other.position);
          if (dSq > 0 && dSq < SEPARATION_RADIUS_SQ) {
              let diff = new THREE.Vector3().subVectors(particle.position, other.position);
              diff.normalize().divideScalar(Math.sqrt(dSq)); 
              sum.add(diff); count++;
          }
      }
      if (count > 0) { sum.divideScalar(count).normalize().multiplyScalar(particle.maxSpeed);
          const steer = new THREE.Vector3().subVectors(sum, particle.velocity).clampLength(0, particle.maxForce);
          return steer;
      }
      return sum;
  }
  function align(particle, particles) { /* ... */ 
      let sum = new THREE.Vector3(); let count = 0;
      for (const other of particles) {
          if (particle.id === other.id) continue;
          if (particle.position.distanceToSquared(other.position) < NEIGHBOR_RADIUS_SQ) {
              sum.add(other.velocity); count++;
          }
      }
      if (count > 0) { sum.divideScalar(count).normalize().multiplyScalar(particle.maxSpeed);
          const steer = new THREE.Vector3().subVectors(sum, particle.velocity).clampLength(0, particle.maxForce);
          return steer;
      }
      return sum;
  }
  function cohesion(particle, particles) { /* ... */ 
      let sum = new THREE.Vector3(); let count = 0;
      for (const other of particles) {
          if (particle.id === other.id) continue;
          if (particle.position.distanceToSquared(other.position) < NEIGHBOR_RADIUS_SQ) {
              sum.add(other.position); count++;
          }
      }
      if (count > 0) { sum.divideScalar(count); return seek(particle, sum); }
      return sum;
  }


  function animate() {
      requestAnimationFrame(animate);
      const deltaTime = 0.0166; time += deltaTime;
      let totalEnergyThisFrame = 0;


      if (eventHorizon.active) { 
          eventHorizon.time += deltaTime * 2.2; // Slightly faster horizon progression
          eventHorizon.strength = Math.max(0, 1.0 - (eventHorizon.time / 1.0)); // Faster fade for more punch
          if (eventHorizon.strength <= 0) eventHorizon.active = false;
          
          // Update uniforms for particles (world space)
          particleSystem.material.uniforms.eventHorizonPos.value.copy(eventHorizon.position);
          particleSystem.material.uniforms.eventHorizonStrength.value = eventHorizon.strength;
          particleSystem.material.uniforms.eventHorizonTime.value = eventHorizon.time;

          // Update uniforms for foam (screen space for position, world for strength/time)
          if (foamMaterial) {
              foamMaterial.uniforms.eventHorizonWorldPos.value.set(eventHorizon.screenPos.x, eventHorizon.screenPos.y, eventHorizon.time * 0.2 + 0.05); // Use z for radius/influence
              foamMaterial.uniforms.eventHorizonStrength.value = eventHorizon.strength;
          }
      } else { // Reset foam event horizon when not active
           if (foamMaterial) foamMaterial.uniforms.eventHorizonStrength.value = 0.0;
      }
      if (foamMaterial) {
          foamMaterial.uniforms.time.value = time;
          foamMaterial.uniforms.averageEnergy.value = averageParticleEnergy; // Pass average energy to foam
      }


      const positions = particleSystem.geometry.attributes.position.array;
      const energies = particleSystem.geometry.attributes.energy.array;
      const linePositions = lineMesh.geometry.attributes.position.array;
      const lineAlphas = lineMesh.geometry.attributes.alpha.array;
      const lineEnergies = lineMesh.geometry.attributes.energy.array;
      let lineVertexPos = 0;

      for (let i = 0; i < particleCount; i++) {
          const pData = particlesData[i];
          pData.numConnections = 0; pData.energy *= 0.985; // Slightly faster decay for more dynamism

          const sep = separate(pData, particlesData).multiplyScalar(2.2); // Increased separation
          const ali = align(pData, particlesData).multiplyScalar(0.7); 
          const coh = cohesion(pData, particlesData).multiplyScalar(0.6); 
          applyForce(pData, sep); applyForce(pData, ali); applyForce(pData, coh);

          if (eventHorizon.active && eventHorizon.strength > 0) { 
              const distToHorizon = pData.position.distanceTo(eventHorizon.position);
              const horizonRadius = eventHorizon.time * 110.0; // Match particle shader
              if (distToHorizon < horizonRadius + 35.0 && distToHorizon > horizonRadius - 35.0) {
                   pData.energy = Math.min(1.0, pData.energy + eventHorizon.strength * 1.2); 
                   const impulseDir = pData.position.clone().sub(eventHorizon.position).normalize();
                   applyForce(pData, impulseDir.multiplyScalar(eventHorizon.strength * 0.1)); // Stronger impulse 
              } else if (distToHorizon < horizonRadius * 0.2 && eventHorizon.time < 0.15) { // Stronger, shorter pull
                  const pullDir = eventHorizon.position.clone().sub(pData.position).normalize();
                  applyForce(pData, pullDir.multiplyScalar(eventHorizon.strength * 0.035)); 
              }
          }
          
          const distToMouseSq = pData.position.distanceToSquared(mouseWorld);
          if (distToMouseSq < 60*60) { // Larger mouse influence radius
              const dirToMouse = mouseWorld.clone().sub(pData.position).normalize();
              applyForce(pData, dirToMouse.multiplyScalar(0.0010 * (1 - Math.sqrt(distToMouseSq)/60))); 
              pData.energy = Math.min(1.0, pData.energy + 0.01);
          }

          pData.velocity.add(pData.acceleration);
          pData.velocity.clampLength(0, pData.maxSpeed);
          pData.position.add(pData.velocity);
          pData.acceleration.multiplyScalar(0); 

          positions[i*3]=pData.position.x; positions[i*3+1]=pData.position.y; positions[i*3+2]=pData.position.z;
          energies[i] = pData.energy;
          totalEnergyThisFrame += pData.energy;

          const halfBox = boundingBoxSize / 2; 
          if (pData.position.x > halfBox * 2.2) pData.position.x = -halfBox * 2.2; if (pData.position.x < -halfBox*2.2) pData.position.x = halfBox*2.2;
          if (pData.position.y > halfBox * 2.2) pData.position.y = -halfBox * 2.2; if (pData.position.y < -halfBox*2.2) pData.position.y = halfBox*2.2;
          if (pData.position.z > halfBox * 0.4) pData.position.z = -halfBox * 0.4; if (pData.position.z < -halfBox*0.4) pData.position.z = halfBox*0.4; // Flatter bounds

          for (let j = i + 1; j < particleCount; j++) { 
              if (pData.numConnections >= maxConnections || particlesData[j].numConnections >= maxConnections) continue;
              const distSq = pData.position.distanceToSquared(particlesData[j].position);
              const combinedEnergyForConnection = pData.energy + particlesData[j].energy;
              if (distSq < connectionDistance * connectionDistance && combinedEnergyForConnection > 0.4) { // Higher energy threshold for connection
                  pData.numConnections++; particlesData[j].numConnections++;
                  const dist = Math.sqrt(distSq);
                  const alpha = Math.max(0, 1.0 - dist / connectionDistance) * Math.min(1.0, combinedEnergyForConnection * 3.0); // Stronger alpha from energy
                  const lineEnergyVal = combinedEnergyForConnection / 2.0;

                  if (pData.energy > 0.04 && particlesData[j].energy < 0.99) particlesData[j].energy = Math.min(1.0, particlesData[j].energy + pData.energy * 0.0002);
                  if (particlesData[j].energy > 0.04 && pData.energy < 0.99) pData.energy = Math.min(1.0, pData.energy + particlesData[j].energy * 0.0002);

                  linePositions[lineVertexPos*3]=pData.position.x; linePositions[lineVertexPos*3+1]=pData.position.y; linePositions[lineVertexPos*3+2]=pData.position.z;
                  lineAlphas[lineVertexPos]=alpha; lineEnergies[lineVertexPos]=lineEnergyVal; lineVertexPos++;
                  linePositions[lineVertexPos*3]=particlesData[j].position.x; linePositions[lineVertexPos*3+1]=particlesData[j].position.y; linePositions[lineVertexPos*3+2]=particlesData[j].position.z;
                  lineAlphas[lineVertexPos]=alpha; lineEnergies[lineVertexPos]=lineEnergyVal; lineVertexPos++;
              }
          }
      }
      averageParticleEnergy = totalEnergyThisFrame / particleCount;
      if (particleSystem) particleSystem.material.uniforms.averageEnergy.value = averageParticleEnergy;
      if (lineMesh) lineMesh.material.uniforms.averageEnergy.value = averageParticleEnergy;

      const cursorContainer = document.getElementById('custom-cursor-container');
      if (cursorContainer) {
          const coreCursor = cursorContainer.querySelector('.orb-core'); 
          const auraRings = cursorContainer.querySelectorAll('.orb-aura-ring'); 
          
          if (coreCursor) {
              coreCursor.style.setProperty('--core-pulse-duration', `${Math.max(0.3, 1.8 - averageParticleEnergy * 1.5)}s`); // More reactive pulse
              coreCursor.style.animationDuration = coreCursor.style.getPropertyValue('--core-pulse-duration'); 
              coreCursor.style.opacity = `${Math.min(1, 0.95 + averageParticleEnergy * 0.15)}`; 
              coreCursor.style.transform = `translate(-50%, -50%) scale(${1 + averageParticleEnergy * 0.4})`; // More scale
          }
          auraRings.forEach((ring, index) => {
              let baseOpacity = [0.65, 0.45, 0.3][index]; // Slightly higher base
              ring.style.opacity = `${Math.min(1, baseOpacity + averageParticleEnergy * 0.5 - index * 0.15)}`; 
              ring.style.setProperty(`--aura-ring${index+1}-pulse-duration`, `${Math.max(0.8, (2.2 + index*0.4) - averageParticleEnergy * 1.4)}s`); 
              ring.style.animationDuration = ring.style.getPropertyValue(`--aura-ring${index+1}-pulse-duration`); 
          });
      }


      lineMesh.geometry.attributes.position.needsUpdate = true; lineMesh.geometry.attributes.alpha.needsUpdate = true; lineMesh.geometry.attributes.energy.needsUpdate = true;
      lineMesh.geometry.setDrawRange(0, lineVertexPos); 
      particleSystem.geometry.attributes.position.needsUpdate = true; particleSystem.geometry.attributes.energy.needsUpdate = true;
      particleSystem.material.uniforms.time.value = time; lineMesh.material.uniforms.time.value = time;
      
      camera.position.x += (mouseWorld.x * 0.02 - camera.position.x) * 0.008; // Very slow, subtle camera drift
      camera.position.y += (mouseWorld.y * 0.02 - camera.position.y) * 0.008;
      camera.lookAt(scene.position);
      composer.render();
  }

  const sections = document.querySelectorAll('.content-section');
  const observerOptions = { root: null, rootMargin: '0px', threshold: 0.08 };
  const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => { 
          entry.target.classList.toggle('is-visible', entry.isIntersecting);
          if (entry.isIntersecting) { 
              const neuralTexts = entry.target.querySelectorAll('.neural-text');
              neuralTexts.forEach(nt => {
                  if (!nt.classList.contains('animated')) { 
                      animateNeuralText(nt); nt.classList.add('animated');
                  }
              });
          }
      });
  }, observerOptions);
  sections.forEach(section => { observer.observe(section); });

  function initNeuralTextAnimations() { 
      document.querySelectorAll('.neural-text').forEach(el => {
          const originalText = el.dataset.textOriginal || el.textContent.trim();
          el.innerHTML = ''; 
          if (originalText) {
              originalText.split('').forEach((char, index) => {
                  const span = document.createElement('span');
                  span.className = 'char';
                  span.textContent = char === ' ' ? '\u00A0' : char; 
                  span.style.animationDelay = `${index * 0.025}s`; 
                  el.appendChild(span);
              });
          }
      });
  }
  function animateNeuralText(element) { /* Animation is CSS driven */ }
  
  const projectCards = document.querySelectorAll('.project-card');
  projectCards.forEach(card => { 
      const innerCard = card.querySelector('.project-card-inner');
      if (!innerCard) return;
      card.addEventListener('mousemove', (e) => {
          const rect = card.getBoundingClientRect();
          const x = e.clientX - rect.left; const y = e.clientY - rect.top;
          const centerX = rect.width / 2; const centerY = rect.height / 2;
          const rotateX = (y - centerY) / centerY * -3; 
          const rotateY = (x - centerX) / centerX * 3;
          innerCard.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.005)`;
          card.style.transform = `scale(1.001)`;
      });
      card.addEventListener('mouseleave', () => {
          innerCard.style.transform = 'rotateX(0deg) rotateY(0deg) scale(1)';
          card.style.transform = `scale(1)`;
      });
  });

  // Timeline Item Tilt Effect
  const timelineItems = document.querySelectorAll('.timeline-item');
  timelineItems.forEach(item => {
      const content = item.querySelector('.timeline-content');
      if (!content) return;

      item.addEventListener('mousemove', (e) => {
          const rect = item.getBoundingClientRect(); 
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const centerX = rect.width / 2;
          const centerY = rect.height / 2; 
          
          const rotateX = (y - centerY) / centerY * -4; 
          const rotateY = (x - centerX) / centerX * 4;  

          content.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.02)`;
      });
      item.addEventListener('mouseleave', () => {
          content.style.transform = 'rotateX(0deg) rotateY(0deg) scale(1)';
      });
  });
  
  window.addEventListener('load', () => { 
      const preloader = document.getElementById('preloader');
      if (preloader) preloader.classList.add('loaded');
      setTimeout(() => {
          initThreeJS();
          document.getElementById('currentYear').textContent = new Date().getFullYear();
          const heroSection = document.getElementById('hero');
          if(heroSection) {
              heroSection.classList.add('is-visible');
              const initialNeuralTexts = document.querySelectorAll('#hero .neural-text, #nav-logo.neural-text');
               initialNeuralTexts.forEach(nt => {
                  if (!nt.classList.contains('animated')) {
                     animateNeuralText(nt); nt.classList.add('animated');
                  }
              });
          }
      }, 500); 
  });

  document.querySelectorAll('nav a.nav-link, a.nav-link[href^="#"]').forEach(anchor => { 
      anchor.addEventListener('click', function (e) {
          if (this.getAttribute('href').startsWith("#")) e.preventDefault();
          if (navSynth && audioInitialized) navSynth.triggerAttackRelease( (Math.random() > 0.5 ? "E4" : "G4"), "32n", Tone.now() + 0.001);
          const targetId = this.getAttribute('href');
          const targetElement = document.querySelector(targetId);
          if (targetElement) {
              const navbarHeight = document.querySelector('nav').offsetHeight;
              const targetPosition = targetElement.getBoundingClientRect().top + window.pageYOffset - navbarHeight - 60; 
              window.scrollTo({ top: targetPosition, behavior: 'smooth' });
          }
      });
  });  