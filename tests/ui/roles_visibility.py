# Q-001: which modules each role sees / can open. Synthetic backend only (all Supabase calls answered locally).
# Usage: serve the repo root on http://localhost:<port>, then: python3 tests/ui/roles_visibility.py tests/ui <port> <screenshot_dir>
import asyncio, json, sys, re
sys.path.insert(0, sys.argv[1])
from demo_data import REST, MENU, ONBOARD
from playwright.async_api import async_playwright
PORT=sys.argv[2]
def handler(role):
    prof={"is_platform_admin":False,"staff":[{"id":7,"name":"Тест "+role,"role":role,"restaurant_id":1,"status":"active"}]}
    async def h(route, req):
        path=req.url.split('.supabase.co')[1]
        if 'pin-login' in path: return await route.fulfill(json={"access_token":"demo","refresh_token":"demo","expires_in":36000,"user":{"id":"u7"}})
        if '/rpc/my_profile' in path: return await route.fulfill(json=prof)
        if '/rpc/onboarding_status' in path: return await route.fulfill(json=ONBOARD)
        if path.startswith('/rest/v1/restaurants'): return await route.fulfill(json=REST)
        if path.startswith('/rest/v1/menu_items'): return await route.fulfill(json=MENU)
        if '/rpc/' in path: return await route.fulfill(json=None)
        return await route.fulfill(json=[])
    return h
VIS="""() => [...document.querySelectorAll('[data-role]')].filter(e=>!e.classList.contains('role-hidden') && e.offsetParent!==null)
          .map(e=>(e=>{const h=e.querySelector('h3');if(h)return h.textContent.trim();return e.innerText.replace(/[^\\p{L}\\p{N} ←\\-]/gu,' ').replace(/\\s+/g,' ').trim().slice(0,40)})(e))"""
HID="""() => [...document.querySelectorAll('[data-role]')].filter(e=>e.classList.contains('role-hidden'))
          .map(e=>(e=>{const h=e.querySelector('h3');if(h)return h.textContent.trim();return e.innerText.replace(/[^\\p{L}\\p{N} ←\\-]/gu,' ').replace(/\\s+/g,' ').trim().slice(0,40)})(e))"""
async def run(pw, role):
    b=await pw.chromium.launch(); ctx=await b.new_context(viewport={'width':1366,'height':900})
    await ctx.route(re.compile(r'.*\.supabase\.co/.*'), handler(role))
    await ctx.route(re.compile(r'^https://(?!.*supabase).*'), lambda r,q: r.abort())
    p=await ctx.new_page(); errs=[]; p.on('pageerror', lambda e: errs.append(str(e)[:150]))
    await p.goto(f'http://localhost:{PORT}/'); await p.wait_for_timeout(700)
    for d in '1234': await p.click(f'#authScreen >> text="{d}"')
    await p.wait_for_timeout(2500)
    vis=await p.evaluate(VIS); hid=await p.evaluate(HID)
    # try opening restricted modules directly (simulates a crafted click / old cached button)
    direct={}
    for t in ['stop','personnel','knowledge','versions','settings']:
        try:
            await p.evaluate(f"openRestaurantModule('{t}')"); await p.wait_for_timeout(500)
            h=await p.evaluate("(()=>{const t=[...document.querySelectorAll('.toast, #toast, .servisium-toast')].map(x=>x.textContent.trim()).filter(Boolean).pop()||'';const v=document.getElementById('masterModuleView');const hh=v&&v.offsetParent?(v.querySelector('h1,h2')?.textContent||''):'';return (hh?'відкрито: '+hh.trim().slice(0,30):'')+(t?' | toast: '+t.slice(0,50):'')})()")
            direct[t]=h or '(нічого)'
        except Exception as e: direct[t]='error: '+str(e)[:60]
    await p.screenshot(path=f'{sys.argv[3]}/role-{role.replace(" ","_")}.png')
    await b.close()
    return {"role":role,"visible":vis,"hidden":hid,"direct_open":direct,"page_errors":errs}
async def main():
    async with async_playwright() as pw:
        out=[await run(pw,r) for r in ['ADMIN','SENIOR WAITER','WAITER']]
    print(json.dumps(out,ensure_ascii=False,indent=1))
asyncio.run(main())
