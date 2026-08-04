# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: login-smoke.ui.spec.ts >> chat-demo Login opens modal and signs in via /apijson BFF
- Location: e2e/login-smoke.ui.spec.ts:3:5

# Error details

```
Error: browserType.launch: Target page, context or browser has been closed
Browser logs:

<launching> /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --disable-updater-scheduler --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --no-sandbox --user-data-dir=/var/folders/x8/2jhwrrd93f79qjpl9pzlnkym0000gn/T/playwright_chromiumdev_profile-zmjfV7 --remote-debugging-pipe --no-startup-window
<launched> pid=34102
[pid=34102][err] [0805/003706.621762:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:41] getxattr size org.chromium.crashpad.database.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
[pid=34102][err] [0805/003706.622779:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:41] getxattr size com.googlecode.crashpad.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
[pid=34102][err] [0805/003706.623111:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:66] setxattr org.chromium.crashpad.database.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
[pid=34102][err] [0805/003706.623669:ERROR:third_party/crashpad/crashpad/util/file/file_io.cc:103] ReadExactly: expected 8, observed 0
[pid=34102][err] [0805/003706.625097:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:41] getxattr size org.chromium.crashpad.database.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
[pid=34102][err] [0805/003706.625307:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:41] getxattr size com.googlecode.crashpad.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
[pid=34102][err] [0805/003706.625584:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:66] setxattr org.chromium.crashpad.database.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
Call log:
  - <launching> /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --disable-updater-scheduler --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --no-sandbox --user-data-dir=/var/folders/x8/2jhwrrd93f79qjpl9pzlnkym0000gn/T/playwright_chromiumdev_profile-zmjfV7 --remote-debugging-pipe --no-startup-window
  - <launched> pid=34102
  - [pid=34102][err] [0805/003706.621762:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:41] getxattr size org.chromium.crashpad.database.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
  - [pid=34102][err] [0805/003706.622779:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:41] getxattr size com.googlecode.crashpad.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
  - [pid=34102][err] [0805/003706.623111:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:66] setxattr org.chromium.crashpad.database.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
  - [pid=34102][err] [0805/003706.623669:ERROR:third_party/crashpad/crashpad/util/file/file_io.cc:103] ReadExactly: expected 8, observed 0
  - [pid=34102][err] [0805/003706.625097:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:41] getxattr size org.chromium.crashpad.database.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
  - [pid=34102][err] [0805/003706.625307:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:41] getxattr size com.googlecode.crashpad.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
  - [pid=34102][err] [0805/003706.625584:ERROR:third_party/crashpad/crashpad/util/mac/xattr.cc:66] setxattr org.chromium.crashpad.database.initialized on file /Users/tommylemon/Library/Application Support/Google/Chrome/Crashpad: Operation not permitted (1)
  - [pid=34102] <gracefully close start>
  - [pid=34102] <kill>
  - [pid=34102] <will force kill>
  - [pid=34102] exception while trying to kill process: Error: kill EPERM
  - [pid=34102] <process did exit: exitCode=null, signal=SIGABRT>
  - [pid=34102] starting temporary directories cleanup
  - [pid=34102] finished temporary directories cleanup
  - [pid=34102] <gracefully close end>

```