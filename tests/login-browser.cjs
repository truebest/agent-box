const { chromium, firefox } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const phase = process.env.LOGIN_PHASE || 'form';
const password = fs.readFileSync('/run/panel-password', 'utf8').trim();
const target = JSON.parse(fs.readFileSync('/work/private/target.json', 'utf8'));
assert(target.name.startsWith('verify-login-'));
const base = `/api/console/agents/${target.name}/${target.uid}`;
const secrets = [password];
const save = (name, value) => fs.writeFileSync('/work/evidence/' + name, JSON.stringify(value, null, 2) + '\n');
const wait = async (check, message, seconds=100) => {
  const end = Date.now() + seconds * 1000;
  while (!await check()) { assert(Date.now() < end, message); await new Promise(resolve => setTimeout(resolve, 250)); }
};
(async () => {
 const browser = await (process.env.BROWSER === 'firefox' ? firefox : chromium).launch({headless:true,args:['--no-sandbox']});
 const options = {ignoreHTTPSErrors:true,viewport:{width:1280,height:900}};
 const context = await browser.newContext(phase === 'resume' ? {...options,storageState:'/work/private/restart-state.json'} : options);
 const errors = [], challenges = [], submitted = [];
 let authorizationHeaders = 0;
 const attach = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.headers()['www-authenticate']) challenges.push(new URL(response.url()).pathname); });
  page.on('request', request => { if (request.headers().authorization) authorizationHeaders++; });
  page.on('websocket', socket => socket.on('framesent', ({payload}) => {
   try {const message=JSON.parse(payload);if(message.type==='submit')submitted.push(message.text);}catch{}
  }));
 };
 const api = async (method,path,data,headers={}) => {
  const response = await context.request.fetch(origin+path,{method,data,headers:{Origin:origin,...headers},timeout:180000});
  assert(response.ok(), `API ${method} ${path}: HTTP ${response.status()}`);
  return response;
 };
 const state = async () => (await api('GET',`/api/agents/${target.name}/session?uid=${encodeURIComponent(target.uid)}`)).json();
 const execute = async argv => {
  const value=await (await api('POST',`/api/agents/${target.name}/exec?uid=${encodeURIComponent(target.uid)}`,{argv})).json();
  assert.equal(value.exit_code,0,'Fixture command failed');return value.output;
 };
 const processIdentity = async () => {
  const process=JSON.parse(await execute(['herdr','pane','process-info','--pane',target.pane])).result.process_info;
  return {shell:process.shell_pid,foreground:process.foreground_process_group_id};
 };
 const frameFor = page => page.frameLocator('iframe[title="Superterminal navigation"]').frameLocator('iframe.console-session-frame');
 const connected = async page => {const frame=frameFor(page);await frame.locator('.conn-live').waitFor({state:'attached',timeout:45000});return frame;};
 const login = async page => {
  await page.getByLabel('Username',{exact:true}).fill('admin');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).waitFor({timeout:45000});
 };
 try {
  secrets.push(...(await context.cookies(origin)).map(cookie=>cookie.value));
  if(phase!=='resume') {
   const restricted=await browser.newContext(options);
   await restricted.addInitScript(()=>{
    for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{get(){throw new DOMException('Storage blocked','SecurityError');}});
    window.BroadcastChannel=class{constructor(){throw new DOMException('Channel blocked','SecurityError');}};
   });
   const restrictedPage=await restricted.newPage();attach(restrictedPage);
   await restrictedPage.goto(origin);
   await restrictedPage.getByRole('form',{name:'Sign in',exact:true}).waitFor();
   assert.equal(await restrictedPage.locator('html').getAttribute('data-theme'),'light');
   await restricted.close();
  }
  const actor=await context.request.get(origin+`/api/agents/${target.name}`, phase==='resume'?{}:{headers:{Authorization:'Basic '+Buffer.from('admin:'+password).toString('base64')}});
  assert.equal((await actor.json()).metadata.uid,target.uid,'Fixture identity changed');
  const page=await context.newPage();attach(page);
  await page.goto(origin+'/#/console?uid='+target.uid);
  if(phase==='resume') {
   await connected(page);
   assert.equal(await page.getByRole('button',{name:'Sign in',exact:true}).count(),0);
   assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
   assert.deepEqual(await processIdentity(),{shell:target.process.shell_pid,foreground:target.process.foreground_process_group_id});
   assert.deepEqual(errors,[]);assert.deepEqual(challenges,[]);assert.equal(authorizationHeaders,0);
   save('login-restart.json',{cookie_survives_panel_pod_replacement:true,same_native_agent_process:true,no_basic_auth_dialog:true,no_input_sent:submitted.length===0,browser:process.env.BROWSER||'chromium'});
   console.log('PASS persistent cookie after panel Pod replacement, native process unchanged');return;
  }
  await page.getByRole('form',{name:'Sign in',exact:true}).waitFor();
  assert.equal(await page.locator('iframe').count(),0,'Protected console loaded before authentication');
  assert(await page.getByRole('img',{name:'Agent Box logo',exact:true}).evaluate(image=>image.complete&&image.naturalWidth>0));
  const user=page.getByLabel('Username',{exact:true}),secret=page.getByLabel('Password',{exact:true});
  assert.equal(await user.getAttribute('autocomplete'),'username');assert.equal(await secret.getAttribute('autocomplete'),'current-password');
  assert.equal(await secret.getAttribute('type'),'password');
  await secret.fill('visibility-test-only');
  await page.getByRole('button',{name:'Show password',exact:true}).click();
  assert.equal(await secret.getAttribute('type'),'text');assert.equal(await secret.inputValue(),'visibility-test-only');
  assert.equal(await page.getByRole('button',{name:'Hide password',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Hide password',exact:true}).press('Enter');
  assert.equal(await secret.getAttribute('type'),'password');
  await secret.fill('');
  await page.setViewportSize({width:390,height:844});
  for(const theme of ['light','dark','cupcake','synthwave']) {
   await page.evaluate(value=>{localStorage.setItem('ui-theme',value);document.documentElement.dataset.theme=value;},theme);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Login overflows mobile viewport');
   await page.screenshot({path:'/work/evidence/login-mobile-'+theme+'.png'});
  }
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:'/work/evidence/login-desktop.png'});
  await user.fill('admin');await secret.fill('wrong-browser-test-password');await secret.press('Enter');
  await page.getByRole('alert').filter({hasText:'Invalid username or password.'}).waitFor();
  assert.equal(await secret.inputValue(),'');assert.equal(await secret.getAttribute('type'),'password');
  await login(page);
  const cookie=(await context.cookies(origin)).find(c=>c.name==='__Host-agent-box-session');assert(cookie);secrets.push(cookie.value);
  assert(cookie.secure&&cookie.httpOnly&&cookie.sameSite==='Strict'&&cookie.path==='/');assert(cookie.expires*1000>Date.now()+6*86400000);
  const frame=await connected(page);
  await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('dark');
  await frame.getByRole('button',{name:'Chat',exact:true}).click();
  const box=frame.getByRole('textbox',{name:'Message',exact:true});await box.waitFor();await box.fill('PRIVATE_UNSENT_LOGIN_DRAFT');
  const preferences=JSON.stringify({theme:'dark',terminalFontSize:17});
  await page.evaluate(settings=>{
   localStorage.setItem('pvm-console:settings',settings);
   localStorage.setItem('pvm-console:test:herdr-web-ui:terminal-line:local:w1:p1','PRIVATE_TERMINAL_DRAFT');
   sessionStorage.setItem('pvm-console:test:herdr-web-ui:terminal-draft:local:w1:p1','PRIVATE_DISCONNECTED_DRAFT');
  },preferences);
  const independent=await browser.newContext(options);
  await require('./browser-auth.cjs')(independent,origin,password);
  const otherCookie=(await independent.cookies(origin)).find(c=>c.name===cookie.name);secrets.push(otherCookie.value);
  let before=await processIdentity();
  if(phase==='form') {
   const prompt=`Use bash to run python3 -c 'import pathlib,time;pathlib.Path("/workspace/login-start").write_text("started");time.sleep(20);pathlib.Path("/workspace/login-done").write_text("continued")'. Run that exact command and reply LOGIN_TASK_DONE.`;
   await box.fill(prompt);await frame.getByRole('button',{name:'Send message',exact:true}).click();
   await wait(async()=>{const r=await context.request.get(origin+`/api/agents/${target.name}/files?path=/workspace/login-start&uid=${encodeURIComponent(target.uid)}`);return r.ok()&&await r.text()==='started';},'Fixture task did not start');
   await box.fill('PRIVATE_UNSENT_LOGIN_DRAFT');
  }
  const otherPage=await context.newPage();attach(otherPage);await otherPage.goto(page.url());await connected(otherPage);
  await page.bringToFront();
  const beforeLogout=await state();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('form',{name:'Sign in',exact:true}).waitFor();await otherPage.getByRole('form',{name:'Sign in',exact:true}).waitFor();
  assert.equal(await page.locator('iframe').count(),0);assert.equal(await otherPage.locator('iframe').count(),0);
  for(const p of [page,otherPage]) {
   const clean=await p.evaluate(()=>{
    const draft=/(?:^|:)herdr-web-ui:(?:composer-draft|composer-sending|terminal-draft|terminal-line|pending):/;
    for(const storage of [localStorage,sessionStorage])for(let i=0;i<storage.length;i++)if(draft.test(storage.key(i)))return false;
    return localStorage.getItem('ui-theme')==='dark'&&JSON.parse(localStorage.getItem('pvm-console:settings')).terminalFontSize===17;
   });assert(clean,'Logout retained a draft or erased preferences');
  }
  const replay=await context.request.get(origin+'/api/console',{headers:{Cookie:cookie.name+'='+cookie.value}});assert.equal(replay.status(),401,'Logged-out cookie was accepted');
  const independentStatus=await independent.request.get(origin+'/api/auth/session');assert.equal((await independentStatus.json()).authenticated,true,'Logout revoked another browser');
  if(phase==='form')await wait(async()=>{const r=await independent.request.get(origin+`/api/agents/${target.name}/files?path=/workspace/login-done&uid=${encodeURIComponent(target.uid)}`);return r.ok()&&await r.text()==='continued';},'Agent task stopped at logout');
  await login(page);const restored=await connected(page);await restored.getByRole('button',{name:'Chat',exact:true}).click();
  assert.equal(await restored.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'');
  assert.deepEqual(await processIdentity(),before);
  const after=await state();if(beforeLogout.runner.agent_session)assert.deepEqual(after.runner.agent_session,beforeLogout.runner.agent_session);
  const fresh=(await context.cookies(origin)).find(c=>c.name===cookie.name);secrets.push(fresh.value);assert(fresh.value!==cookie.value,'Login reused a revoked cookie');
  assert.equal(await page.evaluate(()=>document.cookie.includes('__Host-agent-box-session')),false);
  assert.equal(await page.evaluate(value=>JSON.stringify({...localStorage}).includes(value),password),false);
  if(phase==='form')assert.equal(submitted.filter(text=>text.includes('/workspace/login-start')).length,1);
  assert(!submitted.some(text=>text.includes('PRIVATE_UNSENT_')));
  await context.storageState({path:'/work/private/restart-state.json'});fs.chmodSync('/work/private/restart-state.json',0o600);
  await independent.request.post(origin+'/api/auth/logout',{headers:{Origin:origin}});await independent.close();
  assert.deepEqual(errors,[]);assert.deepEqual(challenges,[]);assert.equal(authorizationHeaders,0);
  const report={form_and_logo:true,mobile_and_all_themes:true,form_with_browser_storage_blocked:true,password_visibility_and_keyboard:true,autocomplete_and_paste_supported:true,generic_login_error:true,secure_seven_day_cookie:true,no_basic_auth_dialog:true,logout_all_tabs:true,revoked_cookie_rejected:true,other_browser_session_preserved:true,drafts_deleted_preferences_preserved:true,same_native_agent_after_relogin:true,task_continues_after_logout:phase==='form',no_automatic_input_replay:true,no_javascript_credential_storage:true,errors,browser:process.env.BROWSER||'chromium'};
  save('login-browser-'+phase+'.json',report);console.log('PASS login form, logo, themes, password toggle, secure cookie, cross-tab logout and native-agent continuity');
 } finally {await context.close();await browser.close();}
})().catch(error=>{
 let message=String(error.stack||error);for(const secret of secrets)if(secret)message=message.split(secret).join('[redacted]');
 console.error(message);process.exit(1);
});
