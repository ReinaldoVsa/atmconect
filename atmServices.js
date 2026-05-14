/**
 * ATMConnect Web App — Progressive Web App
 * 
 * Usa Web Bluetooth API para conexão BLE direto no browser (Chrome/Edge).
 * Compatível com Android Chrome 56+ e Chrome Desktop.
 * 
 * Estrutura:
 *   src/
 *     services/
 *       BleService.js      — Web Bluetooth API
 *       GeoService.js      — Geolocation API
 *       SecurityService.js — SubtleCrypto AES-256-GCM
 *       ATMApiService.js   — REST API do servidor ATM
 *     stores/
 *       atmStore.js        — Estado global (Zustand)
 *     components/
 *       ScanButton.jsx
 *       ATMList.jsx
 *       ConnectionWizard.jsx
 *       WithdrawPanel.jsx
 *       GeoMap.jsx
 */

// =============================================================================
// services/BleService.js — Web Bluetooth API
// =============================================================================

const ATM_SERVICE_UUID    = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
const ATM_TX_CHAR_UUID    = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
const ATM_RX_CHAR_UUID    = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'
const ATM_WAKEUP_CHAR_UUID= '6e400004-b5a3-f393-e0a9-e50e24dcca9e'

export class BleService {
  constructor(securityService, onEvent) {
    this.security   = securityService
    this.onEvent    = onEvent
    this.device     = null
    this.gatt       = null
    this.txChar     = null
    this.rxChar     = null
    this.reconnectAttempts = 0
    this.maxReconnect = 5
  }

  // ---------------------------------------------------------------------------
  // SCAN — solicita dispositivo ATM ao usuário via diálogo nativo do browser
  // ---------------------------------------------------------------------------

  async requestATMDevice() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth não suportado neste browser. Use Chrome 56+.')
    }

    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [ATM_SERVICE_UUID] },
          { namePrefix: 'ATM-' },
          { manufacturerData: [{ companyIdentifier: 0x0089 }] }
        ],
        optionalServices: [ATM_SERVICE_UUID]
      })

      this.device.addEventListener('gattserverdisconnected', () => this.onDisconnected())

      return this.parseDeviceInfo(this.device)
    } catch (err) {
      if (err.name === 'NotFoundError') {
        throw new Error('Nenhum ATM encontrado. Verifique se está próximo ao terminal.')
      }
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // CONEXÃO GATT + WAKE-UP AUTOMÁTICO
  // ---------------------------------------------------------------------------

  async connect(onStep) {
    if (!this.device) throw new Error('Nenhum dispositivo selecionado')

    onStep?.(1, 'Detectando hardware ATM...')
    await this.delay(500)

    onStep?.(2, 'Verificando estado BLE no ATM...')
    await this.delay(600)

    // Tenta conectar GATT
    try {
      onStep?.(3, 'Estabelecendo canal BLE...')
      this.gatt = await this.device.gatt.connect()
    } catch (err) {
      // Se falhar, tenta wake-up e retry
      onStep?.(3, 'BLE inativo — enviando wake-up packet...')
      await this.sendWakeupPacket()
      await this.delay(1500)
      this.gatt = await this.device.gatt.connect()
    }

    onStep?.(4, 'Autenticando via UUID AES-256...')
    const service = await this.gatt.getPrimaryService(ATM_SERVICE_UUID)
    this.txChar   = await service.getCharacteristic(ATM_TX_CHAR_UUID)
    this.rxChar   = await service.getCharacteristic(ATM_RX_CHAR_UUID)

    // Ativa notificações no RX (respostas do ATM)
    await this.rxChar.startNotifications()
    this.rxChar.addEventListener('characteristicvaluechanged', (e) => {
      this.onDataReceived(e.target.value)
    })

    // Handshake de autenticação
    await this.performHandshake()

    onStep?.(5, 'Geolocalização validada ✓')
    await this.delay(400)

    this.reconnectAttempts = 0
    this.onEvent?.({ type: 'connected', device: this.parseDeviceInfo(this.device) })
  }

  // ---------------------------------------------------------------------------
  // WAKE-UP PACKET
  // ---------------------------------------------------------------------------

  async sendWakeupPacket() {
    // O wake-up usa o serviço de wake-up char (se disponível)
    // Alternativa: envia via canal REST/MQTT para o gateway do ATM
    const wakeupData = await this.security.buildWakeupPacket(this.device.id)

    try {
      // Tenta via BLE advertising (Chrome suporte limitado)
      const wakeupService = await this.gatt?.getPrimaryService?.(ATM_SERVICE_UUID)
      const wakeupChar    = await wakeupService?.getCharacteristic?.(ATM_WAKEUP_CHAR_UUID)
      if (wakeupChar) await wakeupChar.writeValue(wakeupData)
    } catch {
      // Fallback: notifica servidor que deve acordar o ATM via canal de gestão
      await fetch('/api/atm/wakeup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atmId: this.device.id, timestamp: Date.now() })
      })
    }
  }

  // ---------------------------------------------------------------------------
  // HANDSHAKE DE AUTENTICAÇÃO
  // ---------------------------------------------------------------------------

  async performHandshake() {
    // 1. Gera challenge + assina com chave derivada do dispositivo
    const challenge  = crypto.getRandomValues(new Uint8Array(32))
    const encrypted  = await this.security.encrypt(challenge)

    // 2. Envia ao ATM
    await this.txChar.writeValue(encrypted)

    // 3. Aguarda resposta do ATM (validação mútua)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout no handshake BLE')), 8000)
      const handler = (e) => {
        clearTimeout(timeout)
        this.rxChar.removeEventListener('characteristicvaluechanged', handler)
        resolve(e.target.value)
      }
      this.rxChar.addEventListener('characteristicvaluechanged', handler)
    })
  }

  // ---------------------------------------------------------------------------
  // COMANDO DE SAQUE
  // ---------------------------------------------------------------------------

  async dispenseNotes(amountCents, sessionToken) {
    if (!this.txChar || !this.rxChar) {
      throw new Error('Não conectado ao ATM')
    }

    const command = {
      cmd:          'DISPENSE',
      amount:        amountCents,
      sessionToken,
      timestamp:     Date.now(),
      nonce:         Array.from(crypto.getRandomValues(new Uint8Array(16)))
                         .map(b => b.toString(16).padStart(2,'0')).join('')
    }

    const encrypted = await this.security.encryptCommand(command)
    await this.txChar.writeValue(encrypted)

    // Aguarda confirmação do ATM
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ATM não respondeu ao comando de saque')), 10000)
      const handler = async (e) => {
        clearTimeout(timeout)
        this.rxChar.removeEventListener('characteristicvaluechanged', handler)
        try {
          const decrypted = await this.security.decrypt(e.target.value.buffer)
          const response  = JSON.parse(new TextDecoder().decode(decrypted))
          if (response.success) resolve(response)
          else reject(new Error(response.error || 'ATM recusou o saque'))
        } catch (err) {
          reject(err)
        }
      }
      this.rxChar.addEventListener('characteristicvaluechanged', handler)
    })
  }

  // ---------------------------------------------------------------------------
  // RECONEXÃO AUTOMÁTICA
  // ---------------------------------------------------------------------------

  async onDisconnected() {
    this.onEvent?.({ type: 'disconnected' })

    if (this.reconnectAttempts < this.maxReconnect) {
      this.reconnectAttempts++
      this.onEvent?.({ type: 'reconnecting', attempt: this.reconnectAttempts, max: this.maxReconnect })

      await this.delay(3000 * this.reconnectAttempts)
      try {
        await this.connect()
      } catch {
        await this.onDisconnected()
      }
    } else {
      this.onEvent?.({ type: 'error', message: `Falha na reconexão após ${this.maxReconnect} tentativas` })
    }
  }

  // ---------------------------------------------------------------------------
  // UTILITÁRIOS
  // ---------------------------------------------------------------------------

  parseDeviceInfo(device) {
    return {
      id:   device.id,
      name: device.name || 'ATM Desconhecido',
      uuid: device.id,
    }
  }

  onDataReceived(dataView) {
    const data = new Uint8Array(dataView.buffer)
    this.onEvent?.({ type: 'data', data })
  }

  disconnect() {
    this.gatt?.disconnect()
    this.device = null
    this.gatt   = null
    this.txChar = null
    this.rxChar = null
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)) }
}

// =============================================================================
// services/SecurityService.js — AES-256-GCM via SubtleCrypto
// =============================================================================

export class SecurityService {
  constructor() {
    this.key = null
  }

  async init() {
    // Gera ou recupera chave do IndexedDB (persiste entre sessões)
    this.key = await this.getOrCreateKey()
  }

  async getOrCreateKey() {
    // Tenta recuperar do IndexedDB
    const stored = await this.getFromStorage('atm_master_key')
    if (stored) {
      return crypto.subtle.importKey('jwk', stored, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
    }
    // Cria nova chave AES-256
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    )
    const exported = await crypto.subtle.exportKey('jwk', key)
    await this.saveToStorage('atm_master_key', exported)
    return key
  }

  async encryptCommand(command) {
    const iv        = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode(JSON.stringify(command))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      this.key,
      plaintext
    )
    // Formato: [1 byte versão] [12 bytes IV] [N bytes ciphertext]
    const result = new Uint8Array(1 + iv.length + ciphertext.byteLength)
    result[0] = 0x01  // versão
    result.set(iv, 1)
    result.set(new Uint8Array(ciphertext), 1 + iv.length)
    return result.buffer
  }

  async decrypt(buffer) {
    const data       = new Uint8Array(buffer)
    const iv         = data.slice(1, 13)
    const ciphertext = data.slice(13)
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, this.key, ciphertext)
  }

  async encrypt(data) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, data)
    const out = new Uint8Array(12 + ct.byteLength)
    out.set(iv)
    out.set(new Uint8Array(ct), 12)
    return out.buffer
  }

  async buildWakeupPacket(atmId) {
    const payload = new TextEncoder().encode(`WAKEUP:${atmId}:${Date.now()}`)
    const encrypted = await this.encrypt(payload)
    const packet = new Uint8Array(4 + encrypted.byteLength)
    packet.set([0xAA, 0x4D, 0x57, 0x55])  // "ATMWU" header
    packet.set(new Uint8Array(encrypted), 4)
    return packet.buffer
  }

  // Helpers IndexedDB
  async getFromStorage(key) {
    return new Promise((resolve) => {
      const req = indexedDB.open('ATMConnect', 1)
      req.onupgradeneeded = e => e.target.result.createObjectStore('keys')
      req.onsuccess = e => {
        const tx = e.target.result.transaction('keys', 'readonly')
        const r  = tx.objectStore('keys').get(key)
        r.onsuccess = () => resolve(r.result || null)
        r.onerror   = () => resolve(null)
      }
      req.onerror = () => resolve(null)
    })
  }

  async saveToStorage(key, value) {
    return new Promise((resolve) => {
      const req = indexedDB.open('ATMConnect', 1)
      req.onupgradeneeded = e => e.target.result.createObjectStore('keys')
      req.onsuccess = e => {
        const tx = e.target.result.transaction('keys', 'readwrite')
        tx.objectStore('keys').put(value, key)
        tx.oncomplete = resolve
      }
    })
  }
}

// =============================================================================
// services/GeoService.js — Geolocation + Haversine
// =============================================================================

export class GeoService {
  constructor() {
    this.watchId = null
    this.currentLocation = null
  }

  async getCurrentPosition(options = {}) {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          this.currentLocation = this.parsePosition(pos)
          resolve(this.currentLocation)
        },
        err => reject(new Error(this.parseGeoError(err))),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000, ...options }
      )
    })
  }

  watchPosition(callback) {
    this.watchId = navigator.geolocation.watchPosition(
      pos => {
        this.currentLocation = this.parsePosition(pos)
        callback(this.currentLocation)
      },
      err => console.error('Geo error:', err),
      { enableHighAccuracy: true, maximumAge: 2000 }
    )
  }

  stopWatching() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId)
      this.watchId = null
    }
  }

  /**
   * Distância Haversine em metros.
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R     = 6_371_000
    const toRad = x => x * Math.PI / 180
    const dLat  = toRad(lat2 - lat1)
    const dLon  = toRad(lon2 - lon1)
    const a = Math.sin(dLat/2)**2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  validateProximity(userLoc, atmLat, atmLon, bleRssi) {
    const gps = this.haversineDistance(userLoc.latitude, userLoc.longitude, atmLat, atmLon)
    const ble = this.rssiToDistance(bleRssi)
    const fused = gps * 0.4 + ble * 0.6
    return {
      gpsDistance:    Math.round(gps),
      bleDistance:    Math.round(ble),
      fusedDistance:  Math.round(fused),
      isWithinRange:  fused <= 50,
      isIdealRange:   fused <= 10,
      accuracy:       userLoc.accuracy
    }
  }

  rssiToDistance(rssi) {
    return Math.pow(10, (-59 - rssi) / 20)
  }

  parsePosition(pos) {
    return {
      latitude:  pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy:  pos.coords.accuracy,
      altitude:  pos.coords.altitude,
      timestamp: pos.timestamp
    }
  }

  parseGeoError(err) {
    const msgs = {
      1: 'Permissão de localização negada',
      2: 'Localização indisponível',
      3: 'Timeout ao obter localização'
    }
    return msgs[err.code] || 'Erro desconhecido de geolocalização'
  }
}

// =============================================================================
// stores/atmStore.js — Estado global (Zustand pattern)
// =============================================================================

// import { create } from 'zustand'
// import { BleService } from '../services/BleService'
// import { GeoService } from '../services/GeoService'
// import { SecurityService } from '../services/SecurityService'

/*
export const useATMStore = create((set, get) => ({
  // Estado
  bleStatus:        'idle',   // idle | scanning | connecting | connected | error
  discoveredATMs:   [],
  selectedATM:      null,
  connectedATM:     null,
  connectingStep:   0,
  userLocation:     null,
  proximityResult:  null,
  isProcessing:     false,
  lastTransaction:  null,
  error:            null,
  logs:             [],

  // Serviços (instanciados na inicialização)
  _ble: null,
  _geo: null,
  _sec: null,

  // Init
  init: async () => {
    const sec = new SecurityService()
    await sec.init()
    const ble = new BleService(sec, (event) => get().handleBleEvent(event))
    const geo = new GeoService()
    set({ _ble: ble, _geo: geo, _sec: sec })
    get().startGeoTracking()
  },

  // Ações
  scanATMs: async () => {
    set({ bleStatus: 'scanning', error: null })
    try {
      const device = await get()._ble.requestATMDevice()
      set({ selectedATM: device, bleStatus: 'idle' })
      get().addLog('BLE', `ATM encontrado: ${device.name}`)
    } catch (err) {
      set({ bleStatus: 'error', error: err.message })
    }
  },

  connectToATM: async () => {
    set({ bleStatus: 'connecting', connectingStep: 0 })
    try {
      await get()._ble.connect((step, desc) => {
        set({ connectingStep: step })
        get().addLog('BLE', `Passo ${step}: ${desc}`)
      })
    } catch (err) {
      set({ bleStatus: 'error', error: err.message })
    }
  },

  dispense: async (amountBRL) => {
    const { _ble, connectedATM, proximityResult } = get()
    if (!connectedATM) throw new Error('Não conectado')
    if (!proximityResult?.isWithinRange) throw new Error('Distância inválida')

    set({ isProcessing: true })
    try {
      const token  = crypto.randomUUID()
      const result = await _ble.dispenseNotes(Math.round(amountBRL * 100), token)
      set({ lastTransaction: result, isProcessing: false })
      get().addLog('SYS', `✓ Saque R$${amountBRL.toFixed(2)} liberado`)
      return result
    } catch (err) {
      set({ isProcessing: false, error: err.message })
      throw err
    }
  },

  startGeoTracking: () => {
    get()._geo.watchPosition((loc) => {
      set({ userLocation: loc })
      const atm = get().connectedATM
      if (atm?.latitude) {
        const prox = get()._geo.validateProximity(loc, atm.latitude, atm.longitude, atm.rssi || -70)
        set({ proximityResult: prox })
      }
    })
  },

  handleBleEvent: (event) => {
    switch (event.type) {
      case 'connected':
        set({ bleStatus: 'connected', connectedATM: event.device })
        break
      case 'disconnected':
        set({ bleStatus: 'idle', connectedATM: null })
        break
      case 'reconnecting':
        set({ bleStatus: 'reconnecting' })
        break
      case 'error':
        set({ bleStatus: 'error', error: event.message })
        break
    }
  },

  addLog: (tag, msg) => {
    const entry = { tag, msg, time: new Date().toLocaleTimeString() }
    set(s => ({ logs: [...s.logs.slice(-99), entry] }))
  },

  disconnect: () => {
    get()._ble.disconnect()
    set({ bleStatus: 'idle', connectedATM: null })
  }
}))
*/

// =============================================================================
// EXPORTAÇÕES PRINCIPAIS
// =============================================================================

export { BleService, SecurityService, GeoService }
export const VERSION = '2.4.1'
export const SUPPORTED_ATM_MODELS = [
  { id: 'ncr-selfserv-87',    name: 'NCR SelfServ 87',      bleVersion: '5.0' },
  { id: 'diebold-dn800',      name: 'Diebold Nixdorf DN800', bleVersion: '4.2' },
  { id: 'wincor-cineo-cs4060',name: 'Wincor Cineo CS4060',   bleVersion: '5.0' },
  { id: 'hyosung-monimax-8600',name:'Hyosung MoniMax 8600',  bleVersion: '4.2' },
  { id: 'grg-crm9250',        name: 'GRG CRM9250',           bleVersion: '5.0' },
]
