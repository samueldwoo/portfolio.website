"""Structure audit: CSSOM survival of the malformed rules, heading order,
landmark/article names, image alt, and the accessible name actually computed
for the trip-cadence columns (aria-label on <li> is not universally honoured,
so this reads Chrome's real AX tree rather than trusting the attribute)."""
import json
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8231"
PAGES = ["", "projects/", "travel/"]

JS = r"""
const sheet = [...document.styleSheets].find(s => (s.href||'').includes('layout.css'));
const findMedia = (txt) => {
  const hits = [];
  const walk = (rules, path) => {
    for (const r of rules) {
      if (r.cssRules) walk(r.cssRules, path + ' > ' + (r.conditionText || r.cssText.slice(0,40)));
      }
  };
  return hits;
};
// Enumerate the two suspect @media blocks and list what SURVIVED parsing.
const blocks = [];
if (sheet) {
  for (const r of sheet.cssRules) {
    if (r.type === CSSRule.MEDIA_RULE) {
      const c = r.conditionText || '';
      if (c.includes('759.98') || c.includes('reduced-motion')) {
        blocks.push({cond: c, rules: [...r.cssRules].map(x => x.cssText.slice(0, 120))});
      }
    }
  }
}
// Did the rules AFTER each malformed block survive as top-level rules?
const allText = sheet ? [...sheet.cssRules].map(r => r.cssText).join('\n') : '';
const survived = {
  'band--dark .pass box-shadow': /\.band--dark \.pass/.test(allText),
  'prefers-contrast block':      /prefers-contrast/.test(allText),
  'pass-wall nth-child(1)':      /pass-wall > \.pass:nth-child\(1\)/.test(allText),
};

const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({
  lvl: +h.tagName[1],
  txt: h.textContent.trim().replace(/\s+/g,' ').slice(0, 48),
  hidden: !!h.closest('[aria-hidden="true"]'),
}));

const imgs = [...document.images].map(i => ({
  src: i.getAttribute('src').split('/').pop(),
  alt: i.getAttribute('alt'),
  hasAlt: i.hasAttribute('alt'),
  w: i.naturalWidth, h: i.naturalHeight,
  attrW: i.getAttribute('width'), attrH: i.getAttribute('height'),
}));

const regions = [...document.querySelectorAll('section,article,aside,nav,main,form,figure')].map(el => ({
  tag: el.tagName.toLowerCase(),
  cls: (el.className||'').toString().slice(0,42),
  label: el.getAttribute('aria-label'),
  by: el.getAttribute('aria-labelledby'),
  hidden: el.getAttribute('aria-hidden') === 'true',
}));

const inputs = [...document.querySelectorAll('input,textarea,select')].map(i => ({
  id: i.id, type: i.type, autocomplete: i.getAttribute('autocomplete'),
  label: !!document.querySelector(`label[for="${i.id}"]`),
}));

// Long link accessible names -- a whole card wrapped in <a> reads as one
// enormous link name unless it carries aria-label/aria-labelledby.
const links = [...document.querySelectorAll('a')].map(a => ({
  href: (a.getAttribute('href')||'').slice(0,40),
  nameLen: (a.getAttribute('aria-label') || a.getAttribute('aria-labelledby')
            ? 0 : a.textContent.trim().replace(/\s+/g,' ').length),
  txt: a.textContent.trim().replace(/\s+/g,' ').slice(0,40),
})).filter(l => l.nameLen > 90);

return {blocks, survived, headings, imgs, regions, inputs, links};
"""


def run(page):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--hide-scrollbars")
    d = webdriver.Chrome(options=opts)
    try:
        d.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                          {"width": 1440, "height": 950, "deviceScaleFactor": 1, "mobile": False})
        d.get(f"{BASE}/{page}")
        time.sleep(1.4)
        res = d.execute_script(JS)
        ax = None
        if page == "travel/":
            d.execute_cdp_cmd("Accessibility.enable", {})
            tree = d.execute_cdp_cmd("Accessibility.getFullAXTree", {})
            ax = []
            for n in tree["nodes"]:
                role = (n.get("role") or {}).get("value")
                name = (n.get("name") or {}).get("value") or ""
                if role == "listitem" and ("trip" in name.lower() or "20" in name):
                    ax.append(name)
            ax = ax[:14]
        return res, ax
    finally:
        d.quit()


for page in PAGES:
    res, ax = run(page)
    print(f"\n{'='*88}\n/{page}\n{'='*88}")
    if page == "":
        print("-- layout.css @media blocks that PARSED --")
        for b in res["blocks"]:
            print(f"  @media {b['cond']}  -> {len(b['rules'])} rule(s) survived")
            for r in b["rules"]:
                print(f"       {r}")
        print("-- rules after the malformed blocks --")
        for k, v in res["survived"].items():
            print(f"     {'OK ' if v else 'LOST'} {k}")

    print("-- headings --")
    prev = 0
    for h in res["headings"]:
        flag = ""
        if prev and h["lvl"] > prev + 1:
            flag = f"  <<< SKIPPED h{prev+1}"
        print(f"   h{h['lvl']} {h['txt']}{flag}")
        prev = h["lvl"]
    h1s = [h for h in res["headings"] if h["lvl"] == 1]
    print(f"   h1 count = {len(h1s)}")

    bad_alt = [i for i in res["imgs"] if not i["hasAlt"]]
    nodim = [i for i in res["imgs"] if not i["attrW"]]
    if res["imgs"]:
        print(f"-- images: {len(res['imgs'])}, missing alt attr: {len(bad_alt)}, "
              f"missing width/height attr: {len(nodim)} --")
        for i in res["imgs"][:12]:
            print(f"   {i['src']:<22} alt={i['alt']!r:<24} natural={i['w']}x{i['h']} attr={i['attrW']}x{i['attrH']}")

    unnamed = [r for r in res["regions"]
               if r["tag"] in ("section", "article", "form", "nav", "aside")
               and not r["label"] and not r["by"] and not r["hidden"]]
    print(f"-- unnamed section/article/form/nav/aside: {len(unnamed)} --")
    for r in unnamed:
        print(f"   <{r['tag']}> .{r['cls']}")

    if res["inputs"]:
        print("-- form fields --")
        for i in res["inputs"]:
            print(f"   #{i['id']:<9} type={i['type']:<9} label={i['label']} autocomplete={i['autocomplete']!r}")

    if res["links"]:
        print(f"-- links with accessible name > 90 chars: {len(res['links'])} --")
        for l in res["links"]:
            print(f"   {l['nameLen']:>4} chars  href={l['href']}  {l['txt']!r}")

    if ax is not None:
        print("-- AX tree: computed names for trip-cadence listitems --")
        for n in ax:
            print(f"   {n!r}")
        if not ax:
            print("   *** NONE -- aria-label on <li> produced no computed name ***")
