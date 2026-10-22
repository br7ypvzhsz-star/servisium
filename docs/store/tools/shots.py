# Synthetic demo data + Playwright script that rendered docs/store/screenshots.
# Usage: serve the repo root on http://localhost:8766, then: python3 shots.py <out_dir> <this_dir>
# All Supabase requests are answered locally with fake data; nothing reaches the live database.
import asyncio, json, sys, re
sys.path.insert(0, sys.argv[2])
from demo_data import REST, PROFILE, MENU, ONBOARD
from playwright.async_api import async_playwright
OUT=sys.argv[1]
async def handle(route, req):
    path=req.url.split('.supabase.co')[1]
    if 'pin-login' in path: return await route.fulfill(json={"access_token":"demo","refresh_token":"demo","expires_in":36000,"user":{"id":"u1","email":"demo@example.invalid"}})
    if '/rpc/my_profile' in path: return await route.fulfill(json=PROFILE)
    if '/rpc/onboarding_status' in path: return await route.fulfill(json=ONBOARD)
    if path.startswith('/rest/v1/restaurants'): return await route.fulfill(json=REST)
    if path.startswith('/rest/v1/menu_items'): return await route.fulfill(json=MENU)
    if '/rpc/' in path: return await route.fulfill(json=None)
    return await route.fulfill(json=[])
async def shoot(pw, name, vw, vh, scale, mobile, steps):
    b=await pw.chromium.launch()
    ctx=await b.new_context(viewport={'width':vw,'height':vh}, device_scale_factor=scale, is_mobile=mobile, has_touch=mobile)
    await ctx.route(re.compile(r'.*\.supabase\.co/.*'), handle)
    await ctx.route(re.compile(r'^https://(?!.*supabase).*'), lambda r,q: r.abort())
    p=await ctx.new_page()
    await p.goto('http://localhost:8766/'); await p.wait_for_timeout(800)
    if steps!='login':
        for d in '1234': await p.click(f'#authScreen >> text="{d}"')
        await p.wait_for_timeout(2500)
        if steps=='menu':
            await p.evaluate("openRestaurantModule('menu')"); await p.wait_for_timeout(2000)
    await p.screenshot(path=f'{OUT}/{name}.png')
    await b.close()
async def main():
    async with async_playwright() as pw:
        for name,vw,vh,sc,mob,st in [
            ('desktop-1-venue',1366,768,2,False,'venue'),
            ('desktop-2-menu',1366,768,2,False,'menu'),
            ('phone-1-login',390,844,3,True,'login'),
            ('phone-2-venue',390,844,3,True,'venue'),
            ('phone-3-menu',390,844,3,True,'menu')]:
            await shoot(pw,name,vw,vh,sc,mob,st); print('ok',name)
asyncio.run(main())
