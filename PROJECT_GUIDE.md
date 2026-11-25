# دليل أقسام المشروع

هاد الدليل كيعطي نظرة على تنظيم Baileys: شنو كيدير كل قسم، شنو أهم الدوال اللي فيه، وكيفاش كتستعمل الواجهة العامة. الأمثلة بـJavaScript وكتفترض أن المشروع مثبت فالتطبيق ديالك.

> الأسماء الداخلية كتقدر تتبدل مع تحديثات WhatsApp أو المشروع. هاد الدليل كيركز على الواجهات الرئيسية، وماشي مرجع لكل دالة داخلية.

## 1. نظرة عامة على طريقة الخدمة

التدفق العام ديال الاتصال والرسائل كيدوز تقريبا بهاد الشكل:

```text
makeWASocket(config)
        │
        ├── Socket/Client: اتصال WebSocket والعقد الثنائية
        ├── Socket: مجموعات، رسائل، حضور، استعلامات
        ├── Signal: تشفير الجلسات والرسائل
        └── Utils: المصادقة، تحليل الرسائل، الوسائط، المساعدات
                 │
                 └── sock.ev: أحداث الاتصال والرسائل والتحديثات
```

`makeWASocket` كيركب إعدادات الاتصال وكيعطيك `sock`. التطبيق كيسمع للأحداث فـ`sock.ev` وكيستعمل دوال `sock` للإرسال والاستعلام. حالة الدخول ومفاتيح التشفير خاصهم يتحفظو بين مرات التشغيل.

## 2. تشغيل سريع

```js
const makeWASocket = require('baileys').default
const {
  useMultiFileAuthState,
  DisconnectReason
} = require('baileys')

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const sock = makeWASocket({ auth: state })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log('مسح QR باستعمال WhatsApp')
    if (connection === 'open') console.log('الاتصال خدام')

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        void start()
      } else {
        console.log('الجلسة تسجلات خروجها؛ خاص تسجيل الدخول من جديد')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const message of messages) {
      if (message.key.fromMe || !message.key.remoteJid) continue
      await sock.sendMessage(message.key.remoteJid, { text: 'وصلاتني رسالتك' })
    }
  })
}

void start()
```

> المثال كيبين الفكرة العامة؛ فالتطبيق الحقيقي زيد معالجة للأخطاء، وما تعاودش الاتصال إلا حسب `DisconnectReason` وحالة التطبيق.

## 3. `lib/Socket` — الاتصال وواجهات WhatsApp

هاد الطبقة كتجمع أجزاء الاتصال وكتخرج socket واحد للتطبيق.

| الملف | الدور |
|---|---|
| `socket.js` | فتح WebSocket، إرسال/استقبال الاستعلامات، وربط الردود بمعرّفاتها. |
| `Client/` | نقل بيانات WhatsApp الثنائية عبر WebSocket. |
| `chats.js` | المحادثات، الحضور، الملف الشخصي، إعدادات المستخدم والإشعارات. |
| `messages-send.js` | تجهيز الرسائل، تشفيرها، رفع الوسائط وإرسالها. |
| `messages-recv.js` | استقبال الرسائل والإيصالات والإشعارات، ثم إصدار الأحداث. |
| `groups.js` | إنشاء المجموعات، قراءة بياناتها وتحديث أعضائها وإعداداتها. |
| `username.js` | حل أسماء المستخدمين وربطها بهويات WhatsApp. |
| `business.js` | الملف التجاري والكتالوج والمنتجات. |
| `newsletter.js` | استعلامات وقنوات/نشرات WhatsApp. |
| `usync.js` | تنسيق استعلامات USync لمعلومات المستخدمين والأجهزة والهويات. |
| `mex.js`, `mex-argo.js` | طبقة استعلامات داخلية لبعض واجهات WhatsApp. |

### دوال شائعة على `sock`

- `makeWASocket(config)`: إنشاء الاتصال مع الإعدادات الافتراضية.
- `sock.sendMessage(jid, content, options)`: إرسال نص أو وسائط أو محتوى رسالة آخر.
- `sock.readMessages(keys)`: إرسال إيصالات القراءة لمفاتيح الرسائل.
- `sock.sendPresenceUpdate(type, jid)`: تحديث الحضور، مثل الكتابة أو التوقف.
- `sock.onWhatsApp(target)`: التحقق من رقم أو JID أو اسم مستخدم.
- `sock.resolveUsername(username)` و`sock.resolveUsernames(usernames)`: حل أسماء المستخدمين.
- `sock.groupMetadata(jid)` وواجهات `group*`: الاستعلام عن المجموعات وتعديلها.
- `sock.ev.on(event, handler)`: استقبال أحداث socket.

### مثال: إرسال نص ووسائط

```js
await sock.sendMessage('212600000000@s.whatsapp.net', {
  text: 'السلام'
})

await sock.sendMessage('212600000000@s.whatsapp.net', {
  image: { url: './photo.jpg' },
  caption: 'تصويرة'
})

await sock.sendMessage('212600000000@s.whatsapp.net', {
  audio: { url: './audio.mp3' },
  mimetype: 'audio/mpeg',
  ptt: false
})
```

رفع الوسائط وتشفيرها كيديرهم مسار الإرسال؛ التطبيق كيعطي المحتوى والخيارات المناسبة لنوع الرسالة.

### مثال: متابعة الأحداث

من الأحداث المستعملة بزاف:

- `connection.update`: تغييرات الاتصال وQR.
- `creds.update`: تبدلات بيانات المصادقة، وخاص تتحفظ.
- `messages.upsert`: رسائل جديدة أو متزامنة.
- `messages.update`: تحديث حالة/محتوى رسالة.
- `messages.delete`: حذف رسائل.
- `groups.update` و`group-participants.update`: تغييرات المجموعات.
- `chats.update` و`contacts.update`: تحديث بيانات المحادثات وجهات الاتصال.

```js
sock.ev.on('messages.upsert', ({ messages, type }) => {
  console.log('نوع التحديث:', type)
  for (const message of messages) {
    console.log(message.key.remoteJid, message.key.id)
  }
})
```

## 4. `lib/Utils` — أدوات مساعدة

هاد القسم كيوفر دوال كتستعملها الطبقات الأخرى، وكاين منه دوال مصدّرة للاستعمال المباشر.

| الملف أو المجموعة | الدور وأمثلة أسماء |
|---|---|
| `use-multi-file-auth-state.js` | `useMultiFileAuthState`: تخزين بيانات الدخول والمفاتيح فمجلد. |
| `use-single-file-auth-state.js`, `use-mongo-file-auth-state.js` | طرق أخرى لحفظ/استرجاع حالة المصادقة. |
| `messages.js`, `process-message.js`, `decode-wa-message.js` | قراءة محتوى الرسالة، تحويلها، واستخراج النصوص والأنواع. |
| `messages-media.js`, `message-composer.js` | تنزيل/رفع الوسائط وتجهيز الرسائل. |
| `history.js`, `event-buffer.js`, `baileys-event-stream.js` | معالجة سجل الرسائل والأحداث وتجميعها. |
| `jid-plotting.js` | أدوات عرض وتحليل JID ومعلومات المرسل. |
| `username.js` | `normalizeUsername`, `isValidUsername`, `resolveMessageTarget`. |
| `chat-control.js` | أدوات الكتابة، تثبيت الرسائل، وإيصالات القراءة. |
| `message-search.js` | `extractMessageText`, `searchMessages`, `searchMessagesRegex`. |
| `vcard.js` | `generateVCard`, `parseVCard`, `createContactCard(s)`. |
| `status-posting.js` | إنشاء أنواع رسائل الحالة والصور والفيديو والصوت. |
| `interactive-message.js`, `templates.js`, `rich-message-utils.js` | إنشاء القوائم والأزرار والقوالب والرسائل المركبة. |
| `link-preview.js`, `crypto.js`, `auth-utils.js`, `signal.js` | معاينة الروابط، التشفير ومساعدات المصادقة وSignal. |

### مثال: حفظ بيانات المصادقة

```js
const { state, saveCreds } = await useMultiFileAuthState('./auth')
const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
```

`useMultiFileAuthState` مناسب للتجارب والبدايات. فالإنتاج، من الأفضل تخزين المفاتيح بشكل دائم وآمن فقاعدة بيانات مناسبة، مع حفظ تحديثاتها كاملة.

## 5. `lib/Signal` — التشفير والجلسات

كيحتوي طبقة Signal لتشفير الرسائل وإدارة مفاتيح الجلسات الفردية والجماعية. كتستعملو `Socket` داخليا، وما خاصش التطبيق عادة ينشئ `GroupCipher` أو يشفّر الرسائل بيده.

أهم المكونات:

- `libsignal.js`: إنشاء مستودع Signal وربط التشفير بمخزن المفاتيح.
- `Group/`: مفاتيح المجموعات وتوزيع مفاتيح المرسل وتشفير/فك تشفير رسائل المجموعة.
- `lid-mapping.js`: `LIDMappingStore` لتخزين العلاقة بين LID وPN واسترجاعها.

أهم دوال ربط LID/PN داخل `LIDMappingStore`:

- `storeLIDPNMappings([{ lid, pn }])`: حفظ الربط بالاتجاهين.
- `getLIDForPN(pn)`: إيجاد LID الموافق لرقم الهاتف.
- `getPNForLID(lid)`: إيجاد JID رقم الهاتف الموافق لـLID.

هاد الربط كيتغذى كذلك من استعلامات USync. ما تفترضش أن كل LID عندو mapping محلي قبل ما يتوفر من الشبكة أو التخزين.

```js
const result = await sock.onWhatsApp('212600000000')
console.log(result?.[0]?.jid, result?.[0]?.lid)
```

## 6. `lib/Store` — تخزين المحادثات والرسائل

المخزن كيجمع الأحداث فحالة قابلة للاستعلام، ولكن خاص يبقى معروف أن المخزن فالذاكرة كيمشي ملي كيتسدّ البرنامج.

- `makeInMemoryStore({ socket, logger })`: إنشاء مخزن للمحادثات والرسائل وجهات الاتصال.
- `store.bind(sock.ev)`: ربط المخزن بأحداث socket وتحديث الحالة تلقائيا.
- `store.readFromFile(path)` و`store.writeToFile(path)`: تحميل/حفظ snapshot محلي عند الحاجة.
- `make-ordered-dictionary.js`: بنية مرتبة لرسائل المحادثة والبيانات المفهرسة.
- `make-cache-manager-store.js`: مساعد تخزين حالة المصادقة باستعمال `cache-manager`.
- `object-repository.js`: مخزن كائنات مفهرس بالمعرّف.

```js
const { makeInMemoryStore } = require('baileys')
const store = makeInMemoryStore({ socket: sock })

store.bind(sock.ev)

const latest = store.messages['212600000000@s.whatsapp.net']?.array.at(-1)
console.log(latest?.message)
```

للتخزين الدائم أو متعدد العمليات، استعمل تخزين خارجي؛ ما تعتمدش على `makeInMemoryStore` كقاعدة بيانات دائمة.

## 7. `lib/Types` — أنواع البيانات والعقود

كيحدد الأشكال المتوقعة لبيانات المصادقة، الرسائل، الأحداث، المجموعات، جهات الاتصال والـsocket. فـJavaScript كتفيد هاد العقود لفهم شكل البيانات؛ وفـTypeScript كتساعد المحرر والمترجم يكشفو أخطاء النوع.

أمثلة الملفات: `Message.js`, `Events.js`, `Socket.js`, `Auth.js`, `GroupMetadata.js`, `Chat.js`, `Contact.js`, `Username.js`.

- `DisconnectReason`: رموز إغلاق الاتصال بحال `loggedOut` و`connectionClosed`.
- أنواع الأحداث كتحدد payload ديال كل event.
- أنواع الرسائل كتحدد `key`, `message`, وبيانات المرسل/المحادثة.

```js
sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
  if (connection === 'close') {
    console.log(lastDisconnect?.error?.output?.statusCode)
  }
})
```

## 8. `lib/Defaults` — الإعدادات الافتراضية والثوابت

`DEFAULT_CONNECTION_CONFIG` كيحدد القيم الافتراضية للاتصال، المهلات، إعادة المحاولة، السجل وسلوك مزامنة التاريخ. `makeWASocket` كيدمج هاد القيم مع إعدادات التطبيق، والقيمة اللي كتمرر كتغلب الافتراضية.

كاينين كذلك ثوابت لمسارات وأنواع الوسائط، إعدادات الكاش، حدود المفاتيح، وعناوين WhatsApp.

```js
const sock = makeWASocket({
  auth: state,
  connectTimeoutMs: 30_000,
  syncFullHistory: false,
  markOnlineOnConnect: false
})
```

بدل غير الخيارات اللي محتاجها؛ ما تبدلش ثوابت البروتوكول إلا إلا كنت عارف أثرها.

## 9. `lib/WABinary` — ترميز بروتوكول العقد

WhatsApp كيتواصل بعقد ثنائية. هاد القسم كيعالج التحويل بينها وبين كائنات JavaScript:

- `encodeBinaryNode(node)`: تحويل عقدة البروتوكول إلى بيانات ثنائية.
- `decodeBinaryNode(buffer)`: قراءة بيانات ثنائية وتحويلها لعقدة.
- `jid-utils.js`: `jidDecode`, `jidEncode`، وفحوصات بحال `isJidUser`, `isLidUser`, `isJidGroup`.
- `generic-utils.js`: قراءة الأبناء والتحقق من العقد.
- `constants.js`, `types.js`: قاموس الوسوم والثوابت والأنواع الثنائية.

```js
const { jidDecode, jidEncode, isLidUser } = require('baileys')

const parsed = jidDecode('212600000000:0@s.whatsapp.net')
const normalized = jidEncode(parsed.user, parsed.server)
console.log(normalized, isLidUser('123456789@lid'))
```

`jidDecode` كيعطي أجزاء JID؛ ماشي بالضرورة كيدير تحويل بين هوية PN وLID. التحويل بيناتهم مسؤولية mapping ديال Signal/USync.

## 10. `lib/WAUSync` — مزامنة واستعلامات المستخدمين

USync كيبني استعلامات مركبة على مجموعة مستخدمين وبروتوكول واحد أو أكثر، ومن بعد كيفسر الرد. البروتوكولات الموجودة كتغطي معلومات الاتصال، الجهاز، LID، الحالة، اسم المستخدم، وخصائص أخرى.

- `USyncQuery`: `withUser`, `withContext`, `withMode` وإضافة بروتوكول مثل `withLIDProtocol()` أو `withContactProtocol()`.
- `USyncUser`: بناء مستخدم عن طريق `withId`, `withPhone`, `withLid`, أو `withUsername`.
- `Protocols/`: تنفيذ محلل الطلب والرد لكل نوع معلومات.
- `sock.onWhatsApp(...)`: واجهة أبسط كتستعمل USync للتحقق من أرقام/JIDs وأسماء المستخدمين.

```js
const users = await sock.onWhatsApp(
  '+212600000000',
  '123456789@lid',
  '@some_username'
)
console.log(users)
```

النتائج كتختلف حسب المعطيات اللي رجعات من WhatsApp؛ تعامل مع `jid`, `lid`, `pn` والحقول الاختيارية كقيم ممكن تغيب.

## 11. `lib/WAM` — رسائل واستعلامات WAM

كيجمع بناء وترميز بيانات WAM وبعض الثوابت المرتبطة بها. `BinaryInfo` و`encode` مكونات داخلية كتستعملها أجزاء الاتصال لإرسال بيانات البروتوكول. ماشي واجهة إرسال رسائل المستخدم العادية؛ للإرسال استعمل `sock.sendMessage`.

## 12. `WAProto/` — مخططات Protobuf

هاد المجلد فيه تعريفات protobuf المولدة وبنية رسائل WhatsApp (`WAProto.proto` وواجهات JavaScript المرافقة). كيتستعمل فقراءة/إنشاء الرسائل البنيوية ومفاتيح المزامنة.

- `proto`: نقطة الدخول لتعريفات الرسائل.
- `proto.Message`: أنواع الرسائل ومحتوياتها.
- `fromObject`, `encode`, `decode`: عمليات التحويل والترميز اللي كتوفرها protobufjs حسب النوع.

ما تحيدش حقول فردية من المخطط المولد بلا تحديث متناسق للمخطط والملفات الناتجة؛ هاد الشي يقدر يكسر التوافق حتى إلا ما كانش عندك ميزة كتستعمل الحقل مباشرة.

## 13. ملفات الجذر

| الملف | الدور |
|---|---|
| `package.json` | اسم الحزمة، نقطة الدخول، الاعتماديات وأوامر npm. |
| `README.md` | توثيق الاستخدام والأمثلة التفصيلية للميزات. |
| `store.js` | مخزن التطبيق للمحادثات والرسائل؛ يستعمل SQLite المحلي على Node الداعم لـ`node:sqlite`، ويرحّل تلقائيا بيانات `store.json` القديمة. نادِ `await store.flush()` قبل إغلاق التطبيق إذا بغيت تنتظر تفريغ الكتابات المجمعة. |
| `engine-requirements.js` | التحقق من متطلبات إصدار Node.js. |
| `LICENSE` | شروط الترخيص. |

## 14. ملاحظة على المكالمات وVoIP

دعم نقل الوسائط ديال VoIP المستقل ما بقاش جزء من المشروع: كود `lib/Voip` وملفات WASM المرتبطة به تحيدو. هاد الشي مختلف على حقول المكالمات اللي ممكن تبقى فمخططات WhatsApp أو على حدث بيانات مكالمة عادي؛ وجود تعريف بروتوكول ما كيعنيش أن تنفيذ VoIP موجود.

## 15. فين تلقى أمثلة أكثر؟

- [README.md](./README.md): دليل الاستعمال الكامل، الوسائط، الرسائل، المجموعات، الأحداث والإعدادات.
- [lib/Socket](./lib/Socket): تنفيذ طبقات socket.
- [lib/Utils](./lib/Utils): الدوال المساعدة.
- [lib/Signal](./lib/Signal): التشفير وربط LID/PN.
- [WAProto](./WAProto): مخططات الرسائل.
