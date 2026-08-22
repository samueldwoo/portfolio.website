/* ============================================================
   Samuel Woo — Motion shim  (motion-shim.js)

   Drop-in replacement for the four Motion (motion.dev) APIs this site
   actually uses, implemented on top of GSAP, which is already loaded.

   WHY THIS EXISTS
   ---------------
   `motion.min.js` is 136.4KB raw / 40.3KB brotli — the single largest
   vendor file on the home page — and `motion-ux.js` reaches for exactly
   four of its entry points:

       Motion.animate(target, props, transition)
       Motion.hover(el, onEnter -> onLeave)
       Motion.press(el, onDown  -> onUp)
       Motion.stagger(seconds)

   Everything else in the bundle (layout animations, scroll, timeline,
   AnimatePresence, the React layer) is dead weight here. This file
   re-implements those four against GSAP's ticker and `gsap.set`.

   WHY GSAP AND NOT A STANDALONE INTEGRATOR
   ----------------------------------------
   Transform composition is load-bearing. motion-ux.js deliberately
   partitions axes — magnetism owns x/rotate, the lift spring owns
   y/scale — and relies on two concurrent animations on ONE element
   composing rather than clobbering each other. Motion did that with a
   per-element value store. GSAP has the same thing (its transform
   cache), so writing every frame through `gsap.set` inherits correct
   composition for free. A hand-rolled shim that wrote
   `el.style.transform` would silently break the axis partition — the
   exact bug the partition was introduced to fix.

   WHY A REAL INTEGRATOR AND NOT A SPRING-SHAPED EASE
   --------------------------------------------------
   The magnet chase RE-TARGETS on every pointer-move frame. An
   ease-based tween restarts from zero velocity each time, which reads
   as stepping. A stateful spring carries velocity across re-targets,
   which is what makes the chase feel continuous. So each (element,
   property) pair keeps its own {value, velocity} and is integrated;
   re-targeting just moves the target and leaves velocity alone.

   Integration is semi-implicit Euler at a FIXED 1/240s substep. The
   stiffest spring in use is `press` (k=900, m=0.5 -> w0 = 42.4 rad/s);
   at a 60fps frame step w0*dt = 0.71, which Euler resolves visibly
   badly, and on a 30fps frame it can diverge outright. Substepping
   makes the result frame-rate independent, which also means the springs
   feel the same on a 120Hz display as on a 60Hz one.

   NOT IMPLEMENTED, ON PURPOSE
   ---------------------------
   `inView`, `scroll`, `timeline`, `animate` on non-DOM targets, and
   duration-derived springs (`duration` alongside `type: "spring"` is
   ignored, matching Motion's own precedence when stiffness/damping are
   given explicitly). If a future call needs one of these, add it here
   rather than reaching back for the full bundle.
   ============================================================ */
(function () {
    "use strict";

    if (!window.gsap) return;                 // nothing to build on
    var gsap = window.gsap;

    /* ---------- property plumbing ----------
       GSAP's transform shorthands happen to be spelled exactly like
       Motion's, so x/y/scale/rotate need no mapping. What DOES need
       care is units: motion-ux.js passes `left: "123px"` and
       `width: 264` in the same call, so a number on a length property
       has to become px while a number on opacity/scale must not. */
    var UNITLESS = { opacity: 1, scale: 1, scaleX: 1, scaleY: 1 };
    var DEGREES  = { rotate: 1, rotateX: 1, rotateY: 1, rotateZ: 1 };

    function isLength(prop) {
        return !UNITLESS[prop] && !DEGREES[prop];
    }

    /* Pull the leading number out of "123px" / "-8" / 264. */
    function toNumber(v) {
        if (typeof v === "number") return v;
        var m = /-?\d*\.?\d+/.exec(String(v));
        return m ? parseFloat(m[0]) : 0;
    }

    function write(el, prop, value) {
        var out = value;
        if (isLength(prop) && prop !== "x" && prop !== "y") {
            /* x/y are GSAP transform shorthands and take bare numbers as
               px already; left/width/top/height need the unit spelled. */
            out = value + "px";
        }
        var o = {};
        o[prop] = out;
        gsap.set(el, o);
    }

    /* Current value, preferring our own spring state so a re-target
       mid-flight continues from where the spring actually is rather than
       from whatever the last committed frame said. */
    function readCurrent(el, prop) {
        var st = springState(el, prop, false);
        if (st) return st.value;
        var got = gsap.getProperty(el, prop);
        return toNumber(got);
    }

    /* ---------- per-element spring registry ---------- */
    var KEY = "__mxSprings";

    function springState(el, prop, create) {
        var bag = el[KEY];
        if (!bag) {
            if (!create) return null;
            bag = el[KEY] = {};
        }
        var st = bag[prop];
        if (!st && create) {
            st = bag[prop] = { value: 0, velocity: 0, target: 0, active: false };
        }
        return st || null;
    }

    /* Every spring currently being integrated. */
    var running = [];      // [{el, prop, state, k, c, m, resolve, cancelled}]
    var ticking = false;

    var SUBSTEP = 1 / 240;

    function ensureTicker() {
        if (ticking) return;
        ticking = true;
        gsap.ticker.add(tick);
    }

    function tick(time, delta) {
        if (!running.length) {
            gsap.ticker.remove(tick);
            ticking = false;
            return;
        }
        /* `delta` is ms. Clamp: a backgrounded tab can hand back a
           multi-second delta, and integrating that many substeps is both
           pointless and a jank spike on return. */
        var dt = Math.min(delta / 1000, 0.064);

        for (var i = running.length - 1; i >= 0; i--) {
            var r = running[i];
            if (r.cancelled) { running.splice(i, 1); continue; }

            var st = r.state;
            var remaining = dt;
            while (remaining > 0) {
                var h = remaining > SUBSTEP ? SUBSTEP : remaining;
                remaining -= h;
                var a = (-r.k * (st.value - st.target) - r.c * st.velocity) / r.m;
                st.velocity += a * h;
                st.value += st.velocity * h;
            }

            /* Rest test, scaled to the property. A 0.01px miss is
               invisible; a 0.01 miss on opacity is not. */
            var restD = UNITLESS[r.prop] ? 0.001 : 0.04;
            var restV = restD * 12;
            if (Math.abs(st.value - st.target) < restD &&
                Math.abs(st.velocity) < restV) {
                st.value = st.target;
                st.velocity = 0;
                st.active = false;
                write(r.el, r.prop, st.value);
                running.splice(i, 1);
                r.resolve();
            } else {
                write(r.el, r.prop, st.value);
            }
        }
    }

    /* Start (or re-target) one spring. Returns a promise for settle. */
    function spring(el, prop, from, to, cfg) {
        var st = springState(el, prop, true);

        if (from !== null && from !== undefined) {
            st.value = from;
            st.velocity = 0;              // an explicit from-keyframe resets
            write(el, prop, st.value);
        } else if (!st.active) {
            st.value = readCurrent(el, prop);
        }
        st.target = to;

        var k = cfg.stiffness == null ? 100 : cfg.stiffness;
        var c = cfg.damping == null ? 10 : cfg.damping;
        var m = cfg.mass == null ? 1 : cfg.mass;

        /* Already there and asleep: nothing to schedule. This is what
           lets an unmoved cursor issue no work, which motion-ux.js
           depends on for the magnet to land exactly on target. */
        if (!st.active && st.value === to) {
            return Promise.resolve();
        }

        /* Re-target: reuse the running entry so velocity survives. */
        for (var i = 0; i < running.length; i++) {
            if (running[i].el === el && running[i].prop === prop && !running[i].cancelled) {
                running[i].k = k; running[i].c = c; running[i].m = m;
                return running[i].promise;
            }
        }

        st.active = true;
        var resolve;
        var promise = new Promise(function (res) { resolve = res; });
        var entry = {
            el: el, prop: prop, state: st,
            k: k, c: c, m: m,
            resolve: resolve, promise: promise, cancelled: false
        };
        running.push(entry);
        ensureTicker();
        return promise;
    }

    function cancelSprings(el, props) {
        for (var i = running.length - 1; i >= 0; i--) {
            var r = running[i];
            if (r.el !== el) continue;
            if (props && props.indexOf(r.prop) === -1) continue;
            r.cancelled = true;
            r.state.active = false;
            r.resolve();
        }
    }

    /* ---------- cubic-bezier, for the one tween that asks for one ----------
       motion-ux.js's form-error shake passes `ease: [0.2, 0.7, 0.2, 1]`.
       GSAP core has no cubic-bezier ease (that's the CustomEase plugin,
       which is not vendored), but GSAP accepts a plain function as an
       ease, so a Newton solve on the x-polynomial is enough. */
    function cubicBezier(x1, y1, x2, y2) {
        function calc(a, b, t) {
            var c = 3 * a, bb = 3 * (b - a) - c, aa = 1 - c - bb;
            return ((aa * t + bb) * t + c) * t;
        }
        function slope(a, b, t) {
            var c = 3 * a, bb = 3 * (b - a) - c, aa = 1 - c - bb;
            return (3 * aa * t + 2 * bb) * t + c;
        }
        return function (p) {
            if (p <= 0) return 0;
            if (p >= 1) return 1;
            var t = p;
            for (var i = 0; i < 8; i++) {
                var xt = calc(x1, x2, t) - p;
                if (Math.abs(xt) < 1e-5) break;
                var d = slope(x1, x2, t);
                if (Math.abs(d) < 1e-6) break;
                t -= xt / d;
            }
            return calc(y1, y2, t);
        };
    }

    function easeFrom(transition) {
        var e = transition && transition.ease;
        if (Array.isArray(e) && e.length === 4) return cubicBezier(e[0], e[1], e[2], e[3]);
        if (typeof e === "function") return e;
        if (typeof e === "string") return e;
        return "power2.out";        // Motion's default feel for short tweens
    }

    /* ---------- targets ---------- */
    function toArray(target) {
        if (!target) return [];
        if (target.nodeType === 1) return [target];
        if (typeof target === "string") return Array.prototype.slice.call(document.querySelectorAll(target));
        if (typeof target.length === "number") return Array.prototype.slice.call(target);
        return [target];
    }

    /* ---------- animate ---------- */
    function animate(target, props, transition) {
        var els = toArray(target);
        transition = transition || {};

        var isSpring = transition.type === "spring" ||
            transition.stiffness != null || transition.damping != null;
        var duration = transition.duration;
        var propNames = Object.keys(props);

        var delayFor = typeof transition.delay === "function"
            ? transition.delay
            : function () { return transition.delay || 0; };

        var jobs = [];
        var tweens = [];
        var stopped = false;

        els.forEach(function (el, index) {
            var delay = delayFor(index, els.length) || 0;

            /* duration: 0 means "be there now" — used by the focus halo
               and the nav indicator when they must not animate. Write
               synchronously so the caller can rely on it having landed. */
            if (duration === 0) {
                propNames.forEach(function (prop) {
                    var v = props[prop];
                    var val = Array.isArray(v) ? v[v.length - 1] : v;
                    cancelSprings(el, [prop]);
                    var st = springState(el, prop, true);
                    st.value = toNumber(val);
                    st.velocity = 0;
                    st.active = false;
                    write(el, prop, st.value);
                });
                return;
            }

            propNames.forEach(function (prop) {
                var v = props[prop];
                var frames = Array.isArray(v) ? v : null;

                /* MULTI-KEYFRAME (>2 stops) is always a tween: it is a
                   scripted path, not a destination, so a spring would
                   have nothing to solve for. */
                if (frames && frames.length > 2) {
                    var seq = frames.map(function (f) { return toNumber(f); });
                    cancelSprings(el, [prop]);
                    var kf = {};
                    kf[prop] = isLength(prop) && prop !== "x" && prop !== "y"
                        ? seq.map(function (n) { return n + "px"; })
                        : seq;
                    var t1 = gsap.to(el, {
                        keyframes: kf,
                        duration: duration == null ? 0.4 : duration,
                        delay: delay,
                        ease: easeFrom(transition),
                        overwrite: "auto"
                    });
                    tweens.push(t1);
                    jobs.push(new Promise(function (res) { t1.eventCallback("onComplete", res); }));
                    return;
                }

                var from = frames ? toNumber(frames[0]) : null;
                var to = toNumber(frames ? frames[1] : v);

                if (isSpring) {
                    if (delay > 0) {
                        jobs.push(new Promise(function (res) {
                            var d = gsap.delayedCall(delay, function () {
                                if (stopped) { res(); return; }
                                spring(el, prop, from, to, transition).then(res);
                            });
                            tweens.push(d);
                        }));
                    } else {
                        jobs.push(spring(el, prop, from, to, transition));
                    }
                } else {
                    cancelSprings(el, [prop]);
                    var vars = {
                        duration: duration == null ? 0.3 : duration,
                        delay: delay,
                        ease: easeFrom(transition),
                        overwrite: "auto"
                    };
                    vars[prop] = isLength(prop) && prop !== "x" && prop !== "y"
                        ? to + "px" : to;
                    if (from !== null) {
                        var fromVars = {};
                        fromVars[prop] = isLength(prop) && prop !== "x" && prop !== "y"
                            ? from + "px" : from;
                        gsap.set(el, fromVars);
                    }
                    /* Keep our spring store in step: a later spring on
                       this property must start from where the tween left
                       it, not from a stale cached value. */
                    var st2 = springState(el, prop, true);
                    st2.value = to;
                    st2.velocity = 0;
                    st2.active = false;
                    var t2 = gsap.to(el, vars);
                    tweens.push(t2);
                    jobs.push(new Promise(function (res) { t2.eventCallback("onComplete", res); }));
                }
            });
        });

        var controls = {
            finished: Promise.all(jobs),
            stop: function () {
                stopped = true;
                tweens.forEach(function (t) {
                    try { t.kill(); } catch (e) { /* already dead */ }
                });
                els.forEach(function (el) { cancelSprings(el, propNames); });
            }
        };
        controls.cancel = controls.stop;
        return controls;
    }

    /* ---------- hover ----------
       Motion's `hover` fires only for mouse-like pointers, so a tap does
       not leave a phone stuck in a hover state. Same filter here. The
       callback may return a "leave" function, matching Motion. */
    function hover(el, onEnter) {
        var leave = null;

        function enter(ev) {
            if (ev.pointerType === "touch") return;
            if (leave) { try { leave(ev); } catch (e) {} leave = null; }
            var r = onEnter(el, ev);
            leave = typeof r === "function" ? r : null;
        }
        function exit(ev) {
            if (!leave) return;
            try { leave(ev); } catch (e) {}
            leave = null;
        }

        el.addEventListener("pointerenter", enter);
        el.addEventListener("pointerleave", exit);
        el.addEventListener("pointercancel", exit);

        return function teardown() {
            el.removeEventListener("pointerenter", enter);
            el.removeEventListener("pointerleave", exit);
            el.removeEventListener("pointercancel", exit);
            exit();
        };
    }

    /* ---------- press ----------
       Pointer AND keyboard, because motion-ux.js routes only natively
       focusable elements here precisely to get the keyboard half (see
       its restriction (1)); non-focusable ones use its own pointer-only
       path. Unlike Motion, this does NOT set tabIndex — that was the
       behaviour motion-ux.js was working around, and reproducing it
       would put unlabelled tab stops back in the page. */
    function press(el, onDown) {
        var up = null;

        function endPress(ev) {
            if (!up) return;
            try { up(el, ev); } catch (e) {}
            up = null;
            window.removeEventListener("pointerup", endPress);
            window.removeEventListener("pointercancel", endPress);
        }

        function down(ev) {
            if (ev.button != null && ev.button !== 0) return;   // primary only
            if (up) endPress(ev);
            var r = onDown(el, ev);
            up = typeof r === "function" ? r : null;
            if (up) {
                /* Listen on window: a pointer released outside the
                   element must still end the press, or the element
                   stays visually held down. */
                window.addEventListener("pointerup", endPress);
                window.addEventListener("pointercancel", endPress);
            }
        }

        function keyDown(ev) {
            if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
            if (ev.repeat) return;
            if (up) return;
            var r = onDown(el, ev);
            up = typeof r === "function" ? r : null;
        }
        function keyUp(ev) {
            if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
            endPress(ev);
        }

        el.addEventListener("pointerdown", down);
        el.addEventListener("keydown", keyDown);
        el.addEventListener("keyup", keyUp);
        el.addEventListener("blur", endPress);

        return function teardown() {
            el.removeEventListener("pointerdown", down);
            el.removeEventListener("keydown", keyDown);
            el.removeEventListener("keyup", keyUp);
            el.removeEventListener("blur", endPress);
            endPress();
        };
    }

    /* ---------- stagger ---------- */
    function stagger(each, opts) {
        var start = (opts && opts.startDelay) || 0;
        return function (index) { return start + index * each; };
    }

    window.Motion = {
        animate: animate,
        hover: hover,
        press: press,
        stagger: stagger,
        __shim: true
    };
})();
