import { ipcMain } from 'electron'
import { getSayTtsService } from '../speech/tts-service'
import type { SpeechSpeakResult } from '../../shared/speech/speech-types'

export function registerTtsHandlers(): void {
  ipcMain.handle(
    'speech:speak',
    (_event, args: { text?: unknown; rate?: unknown }): Promise<SpeechSpeakResult> => {
      const text = typeof args?.text === 'string' ? args.text : ''
      const rate = typeof args?.rate === 'number' ? args.rate : undefined
      return getSayTtsService()
        .speak(text, { rate })
        .then((outcome) => ({ outcome }))
    }
  )

  ipcMain.handle('speech:stopSpeak', () => {
    getSayTtsService().stopSpeaking()
  })
}
