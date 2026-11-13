// 并排的测试包(MFF_TEST_BUILD=1,见 scripts/build-mac-test.sh)。electron.vite.config.ts 给 main 定义 __MFF_TEST_BUILD__:
// 正式包是 false,测试包是 true。不是布尔(比如单测里没定义)→ 按正式包算
declare const __MFF_TEST_BUILD__: boolean | undefined
export const IS_TEST_BUILD: boolean = typeof __MFF_TEST_BUILD__ === 'boolean' ? __MFF_TEST_BUILD__ : false
/** 测试包不检查、不下载、不安装更新 —— 它装在正式包旁边,一次自更新就会被换成正式包 */
export const SELF_UPDATE_ENABLED = !IS_TEST_BUILD
/** Windows 的 AppUserModelID 要和安装器给快捷方式盖的一致(electron-builder 取自 appId) */
export const APP_USER_MODEL_ID = IS_TEST_BUILD ? 'com.zghua.myflowforge.test' : 'com.zghua.myflowforge'
