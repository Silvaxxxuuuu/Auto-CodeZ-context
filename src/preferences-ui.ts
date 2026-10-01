import { APP_PREFERENCES_EVENT, applyAppPreferences } from './app-preferences';

const style = document.createElement('style');
style.id = 'auto-codez-preferences-runtime';
style.textContent = `
html.ac-reduced-motion *,html.ac-reduced-motion *::before,html.ac-reduced-motion *::after{animation-duration:.001ms!important;animation-delay:0ms!important;transition-duration:.001ms!important;scroll-behavior:auto!important}
html[data-ac-density="compact"] .chat-item{min-height:34px;padding-top:5px;padding-bottom:5px}
html[data-ac-density="compact"] .new-item{min-height:34px}
html[data-ac-density="compact"] .settings-nav-item{min-height:50px;padding-top:7px;padding-bottom:7px}
html[data-ac-density="compact"] .settings-row{min-height:66px;padding-top:10px;padding-bottom:10px}
html[data-ac-density="compact"] .profile-provider-row,html[data-ac-density="compact"] .profile-method-row{padding-top:10px;padding-bottom:10px}
`;
if (!document.getElementById(style.id)) document.head.appendChild(style);

applyAppPreferences();
window.addEventListener(APP_PREFERENCES_EVENT, () => applyAppPreferences());
