"""Verify KEYBOARD operation of the putting green.

Why this exists: the green was pointer-only (drag or nothing) while the site's
own case study claimed it was keyboard-navigable. This proves the claim.

Traps this harness respects, all of which have produced false results in this
repo before:
  * DIRECTORY urls only ('/', not '/index.html').
  * Real CDP key events, not synthetic KeyboardEvents -- synthetic events do not
    arm :focus-visible, and the focus ring is one of the things under test.
  * Poll until values STOP changing before reading geometry; webfonts swap after
    first paint and the reveal finishes on a tween.
  * Assert the element is actually reachable by TAB, rather than calling
    .focus() ourselves -- calling focus() would pass even if the element were
    not in the tab order at all, which is the whole question.
"""
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8020"

fails = []


def chk(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}  {detail}")
    if not ok:
        fails.append(name)


def drv(w=1440, h=950):
    o = Options()
    for a in ("--headless=new", f"--window-size={w},{h}",
              "--force-device-scale-factor=1", "--hide-scrollbars"):
        o.add_argument(a)
    o.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    return webdriver.Chrome(options=o)


def key(d, k, code=None, mods=0):
    """Real key press through CDP so :focus-visible and defaults behave."""
    base = {"modifiers": mods, "key": k, "code": code or k}
    if k == "Enter":
        base.update({"windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13, "text": "\r"})
    d.execute_cdp_cmd("Input.dispatchKeyEvent", {"type": "keyDown", **base})
    d.execute_cdp_cmd("Input.dispatchKeyEvent", {"type": "keyUp", **base})


def settle(d, js, tries=60):
    prev, same = None, 0
    for _ in range(tries):
        cur = d.execute_script(js)
        if cur == prev:
            same += 1
            if same >= 3:
                return cur
        else:
            same = 0
        prev = cur
        time.sleep(0.15)
    return prev


d = drv()
d.get(BASE + "/")
d.execute_script("return document.fonts.ready")
settle(d, "return document.querySelectorAll('.reveal.is-visible').length")

# --- the handle exists, is exposed, and is named -------------------------
info = d.execute_script("""
const h=document.querySelector('.hero-ball-handle');
const wrap=document.querySelector('.hero-canvas-wrap');
if(!h) return null;
return {tabindex:h.getAttribute('tabindex'),
        label:h.getAttribute('aria-label'),
        describedby:h.getAttribute('aria-describedby'),
        ariaHidden:h.getAttribute('aria-hidden'),
        wrapHidden:wrap?wrap.getAttribute('aria-hidden'):'no-wrap',
        keysEl:!!document.getElementById('green-keys'),
        liveEl:!!document.getElementById('green-live'),
        canvasHidden:document.querySelector('.hero-canvas').getAttribute('aria-hidden')};""")
chk("ball handle exists", info is not None, str(info))
if info:
    chk("handle is focusable", info["tabindex"] == "0", f"tabindex={info['tabindex']}")
    chk("handle is NOT aria-hidden", info["ariaHidden"] is None)
    chk("wrapper is NOT aria-hidden (no focusable-in-hidden)", info["wrapHidden"] is None,
        f"wrap aria-hidden={info['wrapHidden']}")
    chk("decorative canvas IS still aria-hidden", info["canvasHidden"] == "true")
    chk("handle has an accessible name", bool(info["label"]), info["label"] or "")
    chk("instructions element present + referenced", info["keysEl"] and info["describedby"] == "green-keys")
    chk("live region present", info["liveEl"])

# --- Chrome's OWN accessibility tree must expose the name ---------------
d.execute_cdp_cmd("Accessibility.enable", {})
ax = d.execute_cdp_cmd("Accessibility.getFullAXTree", {})
names = []
for n in ax.get("nodes", []):
    nm = (n.get("name") or {}).get("value") or ""
    if "putting green" in nm.lower():
        names.append((n.get("role", {}).get("value"), nm))
chk("AX tree exposes the green with a name", bool(names), str(names[:2]))

# --- reachable by TAB, not by us calling focus() ------------------------
d.execute_script("document.body.focus(); window.scrollTo(0,0);")
reached, stops = False, []
for i in range(30):
    key(d, "Tab")
    time.sleep(0.09)
    cur = d.execute_script("""
    const a=document.activeElement; if(!a) return null;
    return {cls:a.className||'', tag:a.tagName,
            fv:a.matches(':focus-visible'),
            ring:(()=>{const cs=getComputedStyle(a);
              return cs.outlineStyle!=='none' && parseFloat(cs.outlineWidth)>0.5;})()};""")
    if not cur:
        continue
    stops.append(cur["tag"] + "." + str(cur["cls"])[:22])
    if "hero-ball-handle" in str(cur["cls"]):
        reached = True
        chk("focus ring is visible on the handle", cur["ring"], f"outline={cur['ring']} focus-visible={cur['fv']}")
        chk("UA arms :focus-visible on the handle", cur["fv"])
        break
chk("handle is reachable by Tab", reached, f"{len(stops)} stops: {stops[:8]}")

if reached:
    # --- aiming changes state and announces ----------------------------
    before = d.execute_script("return document.getElementById('green-live').textContent")
    key(d, "ArrowRight")
    time.sleep(0.35)
    after = d.execute_script("return document.getElementById('green-live').textContent")
    chk("arrow key announces aim", bool(after) and after != "", repr(after))

    hint = d.execute_script("""
    const k=document.getElementById('green-keys');
    return {op:+getComputedStyle(k).opacity, display:getComputedStyle(k).display};""")
    chk("instructions visible while focused", hint["op"] > 0.5, str(hint))
    chk("instructions not display:none (would break aria-describedby)",
        hint["display"] != "none", hint["display"])

    # --- power keys must NOT scroll the page ---------------------------
    y0 = d.execute_script("return window.scrollY")
    for _ in range(3):
        key(d, "ArrowDown", "ArrowDown")
        time.sleep(0.12)
    y1 = d.execute_script("return window.scrollY")
    chk("ArrowDown does not scroll the page while aiming", y1 == y0, f"scrollY {y0} -> {y1}")

    # --- Enter putts, and does not scroll ------------------------------
    st0 = d.execute_script("return window.__heroPhase || null")
    y2 = d.execute_script("return window.scrollY")
    key(d, "Enter")
    time.sleep(0.45)
    rolled = d.execute_script("""
    return {live:document.getElementById('green-live').textContent,
            y:window.scrollY};""")
    chk("Enter fires a putt (announced)", "putt" in rolled["live"].lower(), repr(rolled["live"]))
    chk("Enter does not scroll the page", rolled["y"] == y2, f"scrollY {y2} -> {rolled['y']}")

    # Ball must come to rest, i.e. a keyboard putt cannot soft-lock.
    # Poll the HANDLE, not the live region: the region stops changing the moment
    # the putt is announced, so polling it "settles" while the ball is still
    # rolling. MAX_ROLL is 7s, so allow 10.
    stuck = "none"
    for _ in range(100):
        stuck = d.execute_script(
            "return getComputedStyle(document.querySelector('.hero-ball-handle')).display;")
        if stuck != "none":
            break
        time.sleep(0.1)
    chk("handle returns (ball settled, not stuck rolling)", stuck != "none", f"display={stuck}")

errs = [l["message"][:160] for l in d.get_log("browser") if l["level"] == "SEVERE"]
chk("no severe console errors", not errs, str(errs))
d.quit()

print("\nRESULT:", "PASS" if not fails else "FAIL -> " + ", ".join(fails))
sys.exit(1 if fails else 0)
