import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './zh-CN.json'
import enUS from './en-US.json'

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS }
  },
  // UI copy defaults to Simplified Chinese; English is kept in reserve.
  lng: 'zh-CN',
  fallbackLng: 'en-US',
  interpolation: {
    // React already escapes values.
    escapeValue: false
  }
})

export default i18n
