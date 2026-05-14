# ATMConnect — Sistema de Conexão BLE para Terminais ATM
> Versão 2.4.1 | Plataformas: Android Nativo + Web PWA | Produção

---

## Visão Geral da Arquitetura

```
ATMConnect/
├── android/                         # App Android Nativo (Kotlin + Jetpack)
│   └── app/src/main/
│       ├── AndroidManifest.xml      # Permissões BLE, GPS, NFC, Foreground Service
│       └── java/com/atmconnect/
│           ├── ble/
│           │   ├── ATMBleService.kt         # Core BLE: scan, connect, wake-up, dispense
│           │   └── ATMBleBackgroundService.kt# Foreground Service: mantém BLE ativo
│           ├── geo/
│           │   └── ATMGeoService.kt         # GPS + Haversine + Geofence + fusão BLE/GPS
│           ├── security/
│           │   └── ATMSecurityManager.kt    # AES-256-GCM via Android Keystore
│           └── ui/
│               └── ATMViewModel.kt          # ViewModel: orquestra todos os serviços
│
└── web/                             # Progressive Web App (React/Vanilla JS)
    └── src/services/
        └── atmServices.js           # Web Bluetooth API + SubtleCrypto + Geolocation
```

---

## Funcionalidades Implementadas

### 1. Detecção de Dispositivo ATM
- **Android**: `BluetoothLeScanner` com filtros por `ServiceUUID`, `namePrefix` e `ManufacturerID`
- **Web**: `navigator.bluetooth.requestDevice()` com múltiplos filtros
- Identificação de modelo: NCR, Diebold Nixdorf, Wincor, Hyosung, GRG
- RSSI em tempo real com cálculo de qualidade de sinal

### 2. Conexão via UUID do ATM
- UUID primário de serviço BLE: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- Características TX/RX para comunicação bidirecional
- Pareamento automático com autenticação por handshake criptografado

### 3. Wake-up Automático de BLE
```
Fluxo de Wake-up:
1. App detecta ATM via scan passivo (advertising packets)
2. Tenta conectar GATT → se falha, BLE do ATM está desativado
3. Envia wake-up packet assinado via:
   a. Canal NFC (se disponível no ATM)
   b. API REST do servidor de gestão do ATM
   c. BLE Advertising com UUID de wake-up especial
4. ATM verifica assinatura e ativa adaptador BLE
5. App reconecta automaticamente
```

### 4. Geolocalização
- GPS de alta precisão via FusedLocationProvider (Android) / Geolocation API (Web)
- **Fusão BLE+GPS**: `distância_final = GPS×0.4 + BLE×0.6`
- Fórmula Haversine para distância geodésica precisa
- Geofences de 100m por ATM com alerta automático
- Validação de proximidade: máximo 50m para autorizar saque

### 5. Liberação de Notas (Saque)
- Comando `DISPENSE` criptografado com AES-256-GCM
- Session token único por transação
- Nonce anti-replay em cada pacote
- Confirmação criptografada do ATM antes de exibir sucesso

---

## Segurança

| Camada | Implementação |
|--------|--------------|
| Criptografia | AES-256-GCM (NIST SP 800-38D) |
| Chaves | Android Keystore / Web CryptoAPI (não exportáveis) |
| Autenticação | Handshake mútuo challenge-response |
| Anti-replay | Nonce 128-bit por pacote + timestamp |
| Integridade | GCM tag 128-bit autentica todo payload |
| Proximidade | GPS+BLE fusion obrigatória para autorizar saque |
| Sessão | Token único de 256-bit por operação |

---

## Stack Tecnológico

### Android Nativo
```kotlin
// build.gradle (app)
dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("com.google.dagger:hilt-android:2.50")
    implementation("com.google.android.gms:play-services-location:21.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.7.3")
    
    // UI
    implementation("androidx.compose.ui:ui:1.6.0")
    implementation("androidx.compose.material3:material3:1.2.0")
    implementation("androidx.navigation:navigation-compose:2.7.6")
    
    // Biometric (autenticação do usuário antes do saque)
    implementation("androidx.biometric:biometric:1.1.0")
    
    // Maps
    implementation("com.google.maps.android:maps-compose:4.3.0")
    implementation("com.google.android.gms:play-services-maps:18.2.0")
}
```

### Web PWA
```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "zustand": "^4.5.0",
    "react-map-gl": "^7.1.0",
    "maplibre-gl": "^4.0.0",
    "workbox-webpack-plugin": "^7.0.0"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "vite-plugin-pwa": "^0.19.0",
    "@vitejs/plugin-react": "^4.2.0"
  }
}
```

---

## Permissões Necessárias

### Android
| Permissão | Motivo |
|-----------|--------|
| `BLUETOOTH_SCAN` | Scanear ATMs próximos |
| `BLUETOOTH_CONNECT` | Parear e conectar ao ATM |
| `BLUETOOTH_ADVERTISE` | Enviar wake-up packet |
| `ACCESS_FINE_LOCATION` | GPS de alta precisão + BLE scan (Android ≤11) |
| `ACCESS_BACKGROUND_LOCATION` | Manter monitoramento ativo em background |
| `FOREGROUND_SERVICE` | Manter conexão BLE ao minimizar app |
| `USE_BIOMETRIC` | Autenticar usuário antes de saques |
| `NFC` | Canal alternativo de wake-up |

### Web
- `bluetooth` — solicitado ao usuário via `navigator.bluetooth.requestDevice()`
- `geolocation` — solicitado ao usuário na primeira conexão
- Requer HTTPS (obrigatório para Web Bluetooth e Geolocation)

---

## Modelos de ATM Suportados

| Fabricante | Modelo | BLE | Wake-up |
|-----------|--------|-----|---------|
| NCR | SelfServ 87, 88, 91 | 5.0 | Sempre ativo |
| Diebold Nixdorf | DN800, DN200 | 4.2+ | REST API |
| Wincor Nixdorf | Cineo CS4060 | 5.0 | NFC |
| Hyosung | MoniMax 8600, 5600 | 4.2 | REST API |
| GRG Banking | CRM9250, H68N | 5.0 | BLE Advertising |
| Nautilus Hyosung | NH-1800 CE | 4.2 | REST API |

---

## Fluxo Completo de Operação

```
USUÁRIO ABRE APP
      │
      ▼
[1] SCAN BLE
    Android: BluetoothLeScanner (filtro UUID + ManufacturerID)
    Web:     navigator.bluetooth.requestDevice()
      │
      ▼
[2] DETECÇÃO ATM
    - Nome, UUID, RSSI, modelo do hardware
    - Cálculo de distância via RSSI
      │
      ▼
[3] GEOLOCALIZAÇÃO
    - GPS alta precisão (FusedLocation / Geolocation API)
    - Fusão BLE+GPS para distância final
    - Validação: usuário ≤ 50m do ATM
      │
      ▼
[4] VERIFICAÇÃO BLE DO ATM
    BLE ativo? ──Sim──► [5] CONEXÃO GATT
         │
        Não
         │
         ▼
    WAKE-UP AUTOMÁTICO
    (NFC / REST API / BLE Advertising)
         │
         ▼
    Aguarda ATM ativar BLE (~1.5s)
         │
         ▼
[5] CONEXÃO GATT
    - Descobre serviço ATM_SERVICE_UUID
    - Obtém características TX e RX
    - Ativa notificações no RX
      │
      ▼
[6] HANDSHAKE AES-256
    App → ATM: challenge criptografado
    ATM → App: resposta assinada
    (autenticação mútua)
      │
      ▼
[7] CANAL SEGURO ESTABELECIDO
      │
      ▼
[8] USUÁRIO SELECIONA VALOR
    (R$50 / R$100 / R$200 / ou valor custom)
      │
      ▼
[9] COMANDO DISPENSE
    - Gera session token (256-bit)
    - Monta JSON com amount + token + nonce
    - Criptografa AES-256-GCM
    - Envia via TX characteristic
      │
      ▼
[10] ATM PROCESSA
     - Valida assinatura
     - Verifica saldo disponível
     - Libera notas no dispensador
     - Responde via RX characteristic
      │
      ▼
[11] APP EXIBE CONFIRMAÇÃO
     - Valor, ID transação, UUID do ATM, timestamp
```

---

## Como Executar

### Android
```bash
# Clone e abra no Android Studio
git clone <repo>
cd ATMConnect/android
./gradlew assembleDebug
# ou abrir no Android Studio e rodar (requer Android 8.0+)
```

### Web PWA
```bash
cd ATMConnect/web
npm install
npm run dev          # desenvolvimento
npm run build        # produção
# Requer HTTPS para Web Bluetooth funcionar
# Testar com: npx serve dist --ssl-cert
```

---

## Requisitos Mínimos

| Plataforma | Versão Mínima |
|-----------|---------------|
| Android | 8.0 (API 26) — BLE 4.2+ |
| Android recomendado | 12.0 (API 31) — BLE 5.0 |
| Chrome Android | 56+ |
| Chrome Desktop | 70+ |
| Edge | 79+ |
| iOS Safari | ❌ Não suporta Web Bluetooth |

---

## Estrutura de Pacotes Recomendada para Produção

```
com.empresa.atmconnect/
├── di/                   # Hilt dependency injection
│   ├── AppModule.kt
│   └── BleModule.kt
├── ble/
│   ├── ATMBleService.kt
│   ├── ATMBleBackgroundService.kt
│   └── BootReceiver.kt
├── geo/
│   └── ATMGeoService.kt
├── security/
│   ├── ATMSecurityManager.kt
│   └── BiometricHelper.kt
├── network/
│   ├── ATMApiService.kt   # Retrofit para API do servidor
│   └── SessionManager.kt
├── ui/
│   ├── MainActivity.kt
│   ├── ATMViewModel.kt
│   └── screens/
│       ├── ScanScreen.kt
│       ├── ConnectScreen.kt
│       ├── WithdrawScreen.kt
│       └── HistoryScreen.kt
└── data/
    ├── ATMRepository.kt
    └── local/
        └── TransactionDao.kt  # Room para histórico local
```

---

> Desenvolvido como estrutura profissional de produção.
> Todos os módulos seguem Clean Architecture + MVVM + Kotlin Coroutines + Flow.
