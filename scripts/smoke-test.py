"""Browser smoke test for a PRODUCTION build against a THROWAWAY database. Never point it at real data.

It starts `next start` on port 3100 itself, creates a disposable organization through the token-gated bootstrap
route, then drives Chromium through login, the main screens, a customer create, change-password,
forgot-password and the login rate limit. Needs: python3, `pip install playwright`, a Chromium for it,
a built app (`npm run build`), and RUNTIME/MIGRATION database URLs in .env that point at a scratch database.
Run:  python3 scripts/smoke-test.py
"""
import subprocess, time, os, json, urllib.request, urllib.error, sys, uuid
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3100"
env = dict(os.environ, ORG_BOOTSTRAP_TOKEN="smoke-token-123456")
srv = subprocess.Popen(["npx", "next", "start", "-p", "3100"], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), env=env, stdout=open("/tmp/next-start.log", "w"), stderr=subprocess.STDOUT)
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail)); print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))

def post(path, body, headers=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"content-type": "application/json", "x-forwarded-for": f"198.51.100.{uuid.uuid4().hex[:6]}", **(headers or {})}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r: return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()

try:
    for _ in range(40):
        try:
            urllib.request.urlopen(BASE + "/api/v1/health", timeout=2); break
        except Exception: time.sleep(1)
    s, b = post("/api/v1/organizations/bootstrap", {})
    check("bootstrap without token is refused (production mode)", s in (403,), f"{s}")
    suffix = uuid.uuid4().hex[:8]; slug = f"smoke-{suffix}"; email = f"owner.{suffix}@test.mops.invalid"; pw = "Smoke-Passw0rd-12345!"
    s, b = post("/api/v1/organizations/bootstrap", {"organizationName": f"Smoke {suffix}", "organizationSlug": slug, "baseCurrency": "USD", "firstBranchName": "Main", "ownerEmail": email, "ownerFullName": "Smoke Owner", "ownerPassword": pw}, {"x-bootstrap-token": "smoke-token-123456"})
    check("bootstrap with token creates an organization", s == 201, f"{s} {b[:120]}")

    with sync_playwright() as p:
        br = p.chromium.launch(); ctx = br.new_context(); page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # anonymous access redirects to login
        page.goto(BASE + "/customers"); page.wait_for_load_state("load")
        check("anonymous /customers lands on login", "/login" in page.url, page.url)
        page.goto(BASE + "/login")
        page.fill("#organizationSlug", slug); page.fill("#email", email); page.fill("#password", pw)
        page.click("button[type=submit]"); page.wait_for_url("**/dashboard", timeout=20000)
        check("login reaches the dashboard", "/dashboard" in page.url, page.url)
        for path, text in [("/customers", "Customers"), ("/orders", "Sales orders"), ("/quality", "Quality"), ("/reports", "Reports"), ("/reports/job-costs", "Job costs"), ("/reports/profitability", "Profitability"), ("/settings/users", "Settings"), ("/settings/branches", "Settings"), ("/settings/audit-log", "Settings"), ("/shop-floor", "Jobs on the floor"), ("/account/password", "Change password")]:
            r = page.goto(BASE + path); page.wait_for_load_state("load")
            body = page.inner_text("body")
            check(f"{path} renders ({r.status})", r.status == 200 and text in body and "Application error" not in body, f"{r.status}")
        # customer creation through the UI
        page.goto(BASE + "/customers/new"); page.fill("#name", f"Smoke Customer {suffix}"); page.click("button[type=submit]")
        page.wait_for_url(lambda u: "/customers/" in u and not u.endswith("/new"), timeout=15000); page.wait_for_load_state("load")
        check("creating a customer through the form works", f"Smoke Customer {suffix}" in page.inner_text("body"))
        # change password through the UI
        page.goto(BASE + "/account/password")
        page.fill("#currentPassword", pw); page.fill("#newPassword", "Changed-Passw0rd-98765!"); page.fill("#confirm", "Changed-Passw0rd-98765!")
        page.click("button[type=submit]"); page.wait_for_selector("text=Password changed", timeout=15000)
        check("change password through the UI", True)
        # wrong current password shows a field error
        page.fill("#currentPassword", "definitely-wrong-123"); page.fill("#newPassword", "Third-Passw0rd-13579!"); page.fill("#confirm", "Third-Passw0rd-13579!")
        page.click("button[type=submit]"); page.wait_for_selector("text=Current password is incorrect", timeout=15000)
        check("wrong current password is reported", True)
        # forgot password: same confirmation for an unknown account
        pg2 = ctx.new_page(); pg2.goto(BASE + "/forgot-password")
        pg2.fill("#organizationSlug", "no-such-org"); pg2.fill("#email", "nobody@test.mops.invalid"); pg2.click("button[type=submit]")
        pg2.wait_for_selector("text=If that account exists", timeout=15000)
        check("forgot-password shows the neutral confirmation", True)
        # rate limit visible in the UI after repeated failures
        pg3 = br.new_context().new_page(); pg3.goto(BASE + "/login"); msg = ""
        for i in range(7):
            pg3.fill("#organizationSlug", slug); pg3.fill("#email", email); pg3.fill("#password", f"wrong-password-{i}")
            pg3.click("button[type=submit]"); pg3.wait_for_timeout(700)
            if pg3.locator("[role=alert]").count(): msg = pg3.locator("[role=alert]").first.inner_text()
        check("repeated failed logins show the rate-limit message", "Too many attempts" in msg, msg)
        check("no uncaught browser errors during the run", not errors, "; ".join(errors)[:200])
        br.close()
finally:
    srv.terminate()
    try: srv.wait(10)
    except Exception: srv.kill()
bad = [r for r in results if not r[1]]
print(f"\nSMOKE: {len(results)-len(bad)}/{len(results)} passed")
sys.exit(1 if bad else 0)
