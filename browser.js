const choo = require('choo')
const debug = require('debug')('ffs-monitor')
const devtools = require('choo-devtools')
const email = require('apostle.io')
const html = require('choo/html')
const Nanocomponent = require('nanocomponent')
const persist = require('choo-persist')
const Signalhub = require('signalhub')
const socketIo = require('socket.io-client')
const Swarm = require('secure-webrtc-swarm')
const moment = require('moment')

const restUrl = process.env.REST_URL || 'http://localhost:8888'
const wsUrl = process.env.WS_URL || restUrl
const offloaderUrl = process.env.API_URL || restUrl
const apostleKey = process.env.APOSTLE_KEY || 'd867ceb476158bda34e72c0c5e26c2dde0039d9d'

const minSearchLengh = 5
const pollingTime = 1000 * 60 * 15
const socket = socketIo(wsUrl)
const storageName = 'ffs-monitor-v' + require('./package.json').version[0]
const hash = window.location.hash.substr(1)

const app = choo({ href: false })
if (process.env.NODE_ENV !== 'production') {
  app.use(devtools())
}
app.use(persist({
  name: storageName,
  filter: state => Object.assign({}, state, {
    swarm: null,
    displayModal: null
  })
}))
app.use(uiStore)
app.use(nodeStore)
app.route('*', mainView)
app.mount('body')

function notify (id, state, testMail) {
  debug('Tyring to send notifications')

  const msg = `Node ${state.nodes[id].name} came online!`
  new window.Notification('ffs-monitor', { // eslint-disable-line
    body: msg,
    icon: 'assets/ffs-logo-128.png',
    sticky: true
  })

  if (state.sendEmail || testMail) {
    email.domainKey = apostleKey
    const node = testMail ? {
      id: 'ec:08:6b:f7:d4:ae',
      name: 'ffs-aleppo-kiefer'
    } : { id, name: state.nodes[id].name }
    email.deliver('node-changes-state', {
      email: state.email.local.address,
      node
    }).then(x => debug('Sent test email'), err => {
      debug('Sending email failed', err)
    })
  }
}

app.use((state, emitter) => {
  window.Notification.requestPermission()
  emitter.on('DOMContentLoaded', x => {
    document.querySelectorAll('input[type=file]')[0].addEventListener('change', e => {
      const file = e.target.files[0]
      const reader = new window.FileReader()
      reader.onloadend = e => {
        window.localStorage.setItem(storageName, e.target.result)
        window.location.reload()
      }
      reader.readAsText(file)
    }, false)

    if (state.sharing || hash) {
      debug('Starting sharing')
      startSharing(state, emitter)
    }
    const offloader = state.query.offloader
    if (offloader) {
      emitter.emit('saveOffloader', offloader)
      emitter.emit('replaceState', '/') // remove query string
    }
  })

  socket.on('getId', id => {
    emitter.emit('add', id)
  })
  socket.on('search', x => {
    emitter.emit('suggestion', x)
  })
  window.setInterval(x => emitter.emit('updateAll'), pollingTime)
  emitter.emit('updateAll')
})

const Input = class Component extends Nanocomponent {
  constructor () {
    super()
    this.state = {}
  }

  createElement (state) {
    this.state = state
    return html`
      <input onkeypress=${state.onkeypress} onfocus=${state.onfocus} onblur=${state.onblur}
      class=form-control type=text placeholder='Name or MAC address' data-toggle=dropdown>
    `
  }

  update () {}
}
const input = new Input()

function mainView (state, emit) {
  let nodeCount = 0
  let clientCount = 0
  state.ids.reduce((_, id) => {
    const node = state.nodes[id]
    if (!node.flags) return
    nodeCount += +node.flags.online
    clientCount += +node.clientcount
  }, 0)
  return html`<body>
    <div class=modal style='display: ${state.displayModal ? 'block' : 'none'}; z-index: 10; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: grey; opacity: 0.8;'></div>
    <div class=modal tabindex=1 style='display: ${state.displayModal ? 'block' : 'none'}; position: relative; margin: 0 auto;'>
      <div class=modal-dialog>
        <div class=modal-content>
          <div class=modal-header>
            <h5 class=modal-title>Settings</h5>
            <button type=button class=close>
              <span onclick=${x => emit('toggleModal')}>×</span>
            </button>
          </div>
          <div class=modal-body>
            <!-- Sharing link -->
            <div class=form-group>
              <label>Sharing link</label> <span class='badge badge-${state.sharing ? 'success' : 'dark'}'>
                ${state.sharing ? 'enabled' : 'disabled'}
              </span>
              <span class=float-right><a href=# onclick=${toggleSharing}>
                • ${state.sharing ? 'disable' : 'enable'}
              </a></span>
              <p style='line-height: 1.2; text-align: justify;'><small>
                These links can grant read-only access to the list of nodes assembled on this page. The current site will be mirrored automatically as long as the sharing link is enabled and the page remains open. The "Send mail"-link will also enable notification mails.
              </small></p>
              <div class=input-group style='margin-bottom: 6px;' onclick=${x => emit('saveSettings')}>
                <div class=input-group-btn>
                  <button type=button class='btn btn-light dropdown-toggle' style='border: 1px solid rgba(0,0,0,.15); border-right: 0;' onclick=${x => emit('toggleSharingLink')}>
                    ${state.displayedSharingLink === 'noEmails' ? 'No mails' : 'Send mails'}
                  </button>
                </div>
                <input type=url class=form-control ${state.sharing ? '' : 'disabled'} value=${
                  window.location.origin + window.location.pathname + '#' + (
                    state.displayedSharingLink === 'noEmails'
                    ? 'no-mails-' + state.keys.noEmails
                    : 'send-mails-' + state.keys.sendEmails
                  )
                }>
                <div class=input-group-btn>
                  <button class='btn btn-light clippy' data-clipboard-target=#connection-id>
                    <img src=assets/clippy.svg>
                  </button>
                </div>
              </div>
              <input type=email id=email-address-remote class=form-control placeholder=${
                state.displayedSharingLink === 'sendEmails' ? 'Recipient mail address' : ''
                } ${state.displayedSharingLink === 'sendEmails' ? '' : 'disabled'} value=${
                  state.displayedSharingLink === 'sendEmails' ? state.email.remote.address : ''
                }>
            </div>
            <hr>

            <!-- nodejs -->
            <div class=form-group>
              <label>Monitoring server</label> <span class='badge badge-${state.nodejs ? 'success' : 'dark'}'>
                ${state.nodejs ? 'connected' : 'disconnected'}
              </span>
              <span class=float-right><a href=# onclick=${x => emit('toggleEmailLocal')}>
                • ${state.email.local.enabled ? 'disable' : 'enable'}
              </a></span>
              <p style='line-height: 1.2;'><small>
                Let a regular server do the monitoring and sending of notification mails. It will automatically mirror the node list from this page.
              </small></p>
              <div class='alert alert-warning' role=alert style='line-height: 1.2; padding-right: 15px; padding-top: 9px;'>
                <small>
                  <img src=https://avatars2.githubusercontent.com/u/85259 class='rounded float-left' style='width: 62px; height: 61px; margin: -10px 8px 0 -21px; border: 1px solid #ffeeba;'>You have been granted access to an server run by <a href=https://github.com/perguth/>Per Guth</a>.<br> Maybe invite him on a mate cola next time you see him :)
                </small>
              </div>
              <div class=input-group style='margin-bottom: 6px;'>
                <input type=url id=key-offloader value=${
                  state.keys.offloader || ''
                } class=form-control placeholder='Your API key'>
                <span class=input-group-btn>
                  <button class='btn btn-light' type=button onclick=${x => {
                    emit('saveSettings')
                    emit('connectOffloader')
                  }} style='border: 1px solid rgba(0,0,0,.15);'>Connect</button>
                </span>
              </div>
              <input type=email id=email-address-offloader value=${
                state.email.offloader.address || ''
              } class=form-control placeholder='Recipient mail address'>
            </div>
            <hr>
            
            <!-- local email -->
            <div class=form-group>
              <label>Notification mails</label> <span class='badge badge-${state.email.local.enabled ? 'success' : 'dark'}'>
                ${state.email.local.enabled ? 'enabled' : 'disabled'}
              </span>
              <span class=float-right><a href=# onclick=${x => emit('toggleEmailLocal')}>
                • ${state.email.local.enabled ? 'disable' : 'enable'}
              </a></span>
              <p style='line-height: 1.2;'><small>
                As long as this page remains open it can send notification emails when nodes go offline or come back online.
              </small></p>
              <div class=input-group>
                <input type=email id=email-address-local class=form-control placeholder='Recipient email address' value=${state.email.local.address || ''}>
                <span class=input-group-btn>
                  <button class='btn btn-light' type=button onclick=${x => {
                    notify('Trying to send a test mail', state, true)
                    emit('saveRemoteEmailAddress', document.getElementById('mailto').value)
                  }} style='border: 1px solid rgba(0,0,0,.15);'>
                    Send test mail
                  </button>
                </span>
              </div>
            </div>
          </div>

          <!-- save -->
          <div class=modal-footer>
            <button class='btn btn-secondary' onclick=${x => emit('toggleModal')}>Close</button>
          </div>
        </div>
      </div>
    </div>
    <br>
    
    <div class=container>
      <!-- search bar -->
      <header class=row>
        <div class='col input-group dropdown show'>
          ${input.render({ onkeypress: search, onfocus: showSuggestions, onblur: hideSuggestions })}

          <div class=dropdown-menu
            style='
              ${state.displaySuggestions && state.suggestions.length
                ? 'display: block;' : 'display: hidden;'}
              width: calc(100% - 30px); margin-left: 15px; margin-right: 15px;
            '>
            ${state.suggestions.map((x, i) => html`
              <button onclick=${selected.bind(null, i)} class=dropdown-item>${x}</button>
            `)}
          </div>

          <span class=input-group-btn>
            <button onclick=${add} class='btn
              ${document.querySelectorAll('header input')[0] &&
              document.querySelectorAll('header input')[0].value
                  ? 'btn-primary'
                  : 'btn-secondary'}
            '>Save</button>
          </span>
        </div>
        <button onclick=${x => emit('toggleModal')} class='btn btn-light'>⚙</button>
      </header>

      <!-- node list -->
      <div class=row style='text-align: center; display: ${nodeCount ? 'block' : 'none'};'>
        <br>
        <div class=col>
          <i style='color: grey'>
            last update <b>${moment(state.timestamp).fromNow()}</b> -
            overall <b>${nodeCount} of ${state.ids.length} nodes online</b>
            serving <b>${clientCount} client${clientCount !== 1 ? 's' : ''}</b>
          </i>
        </div>
      </div>
      <section class=row  style='text-align: center; display: ${nodeCount ? 'block' : 'none'};'><div class=col>
        <br>
        <ul class=list-group>
          ${state.ids.map((id, i) => {
            const node = state.nodes[id]
            if (!node.flags) return
            return html`<li id=${window.Symbol()}
                class='list-group-item
                ${!node.flags.online ? 'list-group-item-dark' : ''}
                ${node.flags.online && node.clientcount === 0 ? 'list-group-item-info' : ''}
                ${node.flags.online && node.clientcount > 0 ? 'list-group-item-warning' : ''}'
                draggable=true
                ondragstart=${drag.bind(null, i)}
                ondrop=${drop.bind(null, i)}
                ondragover=${x => false}
              >
              <b>${node.name}</b> (<a href='${restUrl}/v1/id/${id}'>${id}</a>),
              ${node.flags.online ? 'online,' : 'offline'}
              ${node.flags.online ? node.clientcount + ' clients' : ''}
              <button
                onclick=${remove.bind(null, i)}
                class='close float-right'
                style='margin-top: -2px; cursor: pointer;'
                type=button>×</button>
            </li>`
          })}
        </ul>
        <br>
      </div></section>
      
      <footer style='margin-top: 8px;'>
        <small style='display: block; text-align: center; color: grey;'>
          <code>v${require('./package.json').version}</code> <a
            href=https://github.com/pguth/ffs-monitor class=github>Github</a>
            has the source! <a href=${
              'data:application/octet-stream;charset=utf-8;base64,' +
              window.btoa(window.localStorage.getItem(storageName))
          } download=ffs-monitor.localStorage.txt>Export</a>, <a onclick=${
            x => document.querySelectorAll('input[type=file]')[0].click()
          } href=#>import</a> or <a onclick=${x => emit('toggleModal')} href=#>transfer</a> data.
        </small>
      </footer>
      <br>
    </div>
    <input type=file style='display: none;'>
  </body>`

  function toggleSharing () {
    emit('toggleSharing')
    if (state.sharing) startSharing(state)
    else state.swarm.close()
  }

  function hideSuggestions () {
    setTimeout(x => emit('toggleSuggestions', false), 300)
  }

  function showSuggestions () {
    const input = document.querySelectorAll('header input')[0].value
    if (input.length >= minSearchLengh) emit('toggleSuggestions', true)
  }

  function selected (i) { // put selection into input field
    const selection = document.querySelectorAll('header .dropdown-menu button')[i].innerHTML
    document.querySelectorAll('header input')[0].value = selection
  }

  function search ({ keyCode }) { // google instant style
    const newInput = String.fromCharCode(keyCode)
    const previousInput = document.querySelectorAll('header input')[0].value
    const search = previousInput + newInput
    if (search.length < minSearchLengh) {
      emit('toggleSuggestions', false)
      return
    }
    emit('toggleSuggestions', true)
    emit('inputChange', search)
    socket.emit('search', search)
  }

  function drag (from, e) {
    e.dataTransfer.setData('text/plain', from)
  }
  function drop (to, e) {
    e.preventDefault()
    const from = e.dataTransfer.getData('text')
    emit('flip', { from, to })
  }

  function add () {
    const input = document.querySelector('header input').value
    socket.emit('getId', input)
    document.querySelector('header input').value = ''
  }
  function remove (i) {
    emit('remove', i)
  }
}

function uiStore (state, emitter) {
  state.suggestions = state.suggestions || []
  state.input = state.input || ''
  state.displaySuggestions = false
  state.displayedSharingLink = state.displayedSharingLink || 'noEmails'
  state.email = state.email || {
    local: {},
    remote: {},
    offloader: {}
  }
  state.keys = state.keys || {
    noEmails: Swarm.createKey(),
    sendEmails: Swarm.createKey(),
    offloader: ''
  }

  emitter.on('render', x => {
    // keep hash intact otherwise lost on 'render'
    // TODO: what's the choo way?
    if (hash) window.location.hash = '#' + hash
  })

  emitter.on('saveOffloader', x => {
    state.keys.offloader = x
    emitter.emit('render')
  })

  emitter.on('saveSettings', x => {
    debug('Saving settings')
    state.email.local.address = document.getElementById('email-address-local').value
    state.email.remote.address = document.getElementById('email-address-remote').value
    state.email.offloader.address = document.getElementById('email-address-offloader').value
    state.keys.offloader = document.getElementById('key-offloader').value
  })
  emitter.on('toggleSuggestions', x => {
    state.displaySuggestions = x
    emitter.emit('render')
  })
  emitter.on('inputChange', x => {
    state.input = x
    emitter.emit('render')
  })
  emitter.on('suggestion', x => {
    state.suggestions = [...x.names, ...x.ids]
    emitter.emit('render')
  })
  emitter.on('toggleModal', x => {
    emitter.emit('saveSettings')
    state.displayModal = !state.displayModal
    emitter.emit('render')
  })
  emitter.on('toggleSharing', x => {
    state.sharing = !state.sharing
    emitter.emit('render')
  })
  emitter.on('toggleRemoteMailing', x => {
    state.remoteMailing = !state.remoteMailing
    emitter.emit('render')
  })
  emitter.on('saveRemoteEmailAddress', x => {
    state.email.local.address = x
  })
  emitter.on('toggleEmailLocal', x => {
    state.email.local.enabled = !state.email.local.enabled
    emitter.emit('render')
  })
  emitter.on('connectOffloader', x => {
    const headers = new window.Headers()
    headers.append('Content-Type', 'application/json')
    window.fetch(offloaderUrl + '/v1/offload', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: state.keys.offloader,
        nodes: Object.keys(state.nodes),
        email: state.email.offloader.address
      })
    }).then(res => {
      res.json().then(res => {
        if (res.err) {
          debug('Offloader: ' + res.err)
          return
        }
        debug('Offloader: API key accepted')
      })
    })
  })
  emitter.on('toggleSharingLink', x => {
    state.displayedSharingLink = state.displayedSharingLink === 'noEmails'
      ? 'sendEmails' : 'noEmails'
    emitter.emit('render')
  })
}

function startSharing (state, emitter) {
  const hub = new Signalhub(
    `ffs-monitor-v${require('./package.json').version[0]}`,
    [
      // 'https://signalhub.perguth.de:65300/',
      'http://localhost:7000'
    ] // TODO: Multiple hubs for redundancy
  )
  const peers = []
  let ephemeralKey
  if (hash) {
    if (emitter) {
      console.log('replaceState')
      emitter.emit('replaceState', '#' + hash)
    }
    ephemeralKey = hash.split('-').pop()
  }
  const keys = Object.keys(state.keys).map(type => {
    if (type === 'offloader') return state.keys[type].wrtc
    return state.keys[type]
  })
  const swarm = new Swarm(hub, { keys })
  if (ephemeralKey) swarm.keys.push(ephemeralKey)

  window.onbeforeunload = x => {
    debug('Closing swarm and peers')
    peers.forEach(x => x.destroy)
    swarm.close()
  }

  swarm.on('peer', peer => {
    debug('Peer connected')
    peers.push(peers)
    if (!hash) {
      debug('Sending data')
      const data = JSON.parse(window.localStorage.getItem(storageName))
      if (peer.sharedKey === state.keys.noEmails) {
        debug('Remote should not send emails')
        data.email.local.enabled = false
      }
      if (peer.sharedKey === state.keys.sendEmails) {
        debug('Remote should send emails')
        data.email.local.enabled = true
      }
      data.displayedSharingLink = 'noEmails'
      data.email.local.address = data.email.remote.address
      delete data.email.remote.address
      delete data.keys
      peer.send(JSON.stringify(data))
      return
    }
    peer.on('data', data => {
      debug('Receiving data')
      window.localStorage.setItem(storageName, data.toString())
      window.location.reload()
    })
  })
}

function nodeStore (state, emitter) {
  state.ids = state.ids || []
  state.nodes = state.nodes || {}
  state.timestamp = '' || state.timestamp

  emitter.on('add', id => {
    if (state.ids.indexOf(id) !== -1) return
    state.nodes[id] = {}
    state.ids.push(id)
    emitter.emit('update', id)
  })

  emitter.on('remove', i => {
    state.ids.splice(i, 1)
    emitter.emit('render')
  })

  emitter.on('update', id => {
    const url = restUrl + '/v1/id/' + id
    window.fetch(url).then(res => {
      res.json().then(node => {
        state.timestamp = node.timestamp
        if (!state.nodes[id].online && node.online) {
          notify(id, state)
        }
        if (state.nodes[id].online && !node.online) {
          notify(`Node ${node.name} went offline!`, id, state)
        }
        state.nodes[id] = node
        emitter.emit('render')
      })
    })
  })

  emitter.on('updateAll', x => {
    state.ids.forEach(id => emitter.emit('update', id))
  })

  emitter.on('flip', ({ from, to }) => {
    const tmp = state.ids[to]
    state.ids[to] = state.ids[from]
    state.ids[from] = tmp
    emitter.emit('render')
  })
}
