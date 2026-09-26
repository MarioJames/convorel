// Accessible names are matched only inside an independently verified control
// scope. Observed DOM contracts are fallback identities when names are absent.
export const SEND_NAMES = [
  "Send",
  "Send message",
  "发送",
  "发送消息",
  "Envoyer",
  "Envoyer le message",
];
export const STOP_NAMES = [
  "Stop",
  "Stop generating",
  "Stop answering",
  "停止",
  "停止生成",
  "中止",
  "Arrêter",
];
export const COPY_NAMES = [
  "Copy",
  "Copy response",
  "复制",
  "复制回答",
  "Copier",
  "Copier la réponse",
];
export const RENAME_NAMES = [
  "Rename",
  "Rename chat",
  "重命名",
  "重命名聊天",
  "Renommer",
];
export const MODEL_NAMES = [
  "Select ChatGPT model",
  "Select model",
  "选择模型",
  "选择 ChatGPT 模型",
  "Choisir le modèle",
];
export const LATEST_NAMES = ["Latest", "最新", "Le plus récent"];
export const COMPOSER_SELECTOR =
  'form[data-chatgpt-composer] [data-composer-markdown][role="textbox"], #prompt-textarea';
export const COPY_SELECTOR =
  'button[data-testid="copy-turn-action-button"], .turn-action-controls button:has(svg path[d^="M13.468 11.1216"])';
export const STOP_SELECTOR =
  'button[data-testid="stop-button"], form[data-chatgpt-composer] button[type="button"]:has(svg path[d^="M4.5 5.75C4.5 5.05964"])';
export const RENAME_MASK_PREFIX = "M11.7313%204.20472";
export const MODEL_PICKER =
  ':is([data-testid="composer-intelligence-picker-content"], [data-model-picker-view])';
export const MODEL_SELECT = `${MODEL_PICKER} :is([role="menuitem"][aria-expanded], [data-model-picker-view-toggle="true"])`;
export const MODEL_POWER = `${MODEL_PICKER} :is([data-testid="composer-model-picker-slider-simple-view"] [role="menuitem"]:has([data-model-reasoning-effort-slider]), [data-reasoning-slider="true"])`;
// The picker places its rolling default before the explicitly versioned models.
export const MODEL_LATEST = `${MODEL_PICKER} :is([data-testid="composer-model-picker-slider-advanced-view"] [role="group"], [data-active="true"] [data-active="true"] > div) > [role="menuitemradio"]:first-of-type`;

// Rename has no semantic test id. Match its observed icon only inside the target
// conversation menu; a changed icon fails closed rather than selecting by position.
export const RENAME_ICON =
  "M11.6258 3.30375C13.0516 1.88123 15.3202 1.91012 16.6805 3.29496C18.0834 4.64996 18.1292 6.92825 16.6893 8.36821L9.68929 15.3682L9.68832 15.3672C8.9762 16.1131 8.0665 16.6184 7.11605 16.8389L7.11507 16.8399L3.24789 17.7276L3.24691 17.7256C3.08016 17.7653 2.74207 17.799 2.4725 17.5303C2.20162 17.2601 2.23613 16.9199 2.27621 16.753H2.27425L3.1639 12.8956C3.38813 11.8986 3.89924 11.028 4.6014 10.3272L11.6258 3.30375ZM5.54183 11.2686C5.00143 11.8078 4.62462 12.4592 4.46078 13.1905L4.4598 13.1944L3.7557 16.2461L6.81722 15.543C7.52306 15.3789 8.20539 15.0001 8.73617 14.4405L14.3944 8.78129L11.2118 5.5977L5.54183 11.2686ZM15.742 4.23637C14.9045 3.37296 13.4757 3.3368 12.5653 4.24516L12.1522 4.65727L15.3348 7.84086L15.7489 7.42778C16.6655 6.51112 16.6228 5.08792 15.7577 4.252L15.742 4.23637Z";
