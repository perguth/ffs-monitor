let choo = require('choo')
let html = require('choo/html')
let Nanocomponent = require('nanocomponent')
let persist = require('choo-persist')
let socketIo = require('socket.io-client')

let restUrl = 'ffs-monitor.perguth.de'
let wsUrl = 'ffs-monitor.perguth.de:63054'
let minSearchLengh = 5
let socket = socketIo(wsUrl)
let app = choo()
app.use(persist({name: 'ffs-monitor-' + require('./package.json').version}))
app.use(uiStore)
app.use(nodeStore)
app.route('*', mainView)
app.mount('body')

app.use((state, emitter) => {
  socket.on('search', x => {
    emitter.emit('suggestion', x)
  })
  // emitter.emit('add', '64:70:02:aa:ba:f8')
  // emitter.emit('add', '14:cc:20:8a:3c:7e')
  window.setInterval(x => {
    emitter.emit('updateAll')
  }, 1000 * 10)
  emitter.emit('updateAll')
})

let Input = class Component extends Nanocomponent {
  constructor () {
    super()
    this.state = {}
  }
  createElement (state) {
    this.state = state
    return html`
      <input onkeypress=${state.onkeypress} onfocus=${state.onfocus} onblur=${state.onblur}
      class=form-control type=text placeholder='node name or mac address' data-toggle=dropdown>
    `
  }
  update (x) {}
}
let input = new Input()

function mainView (state, emit) {
  return html`<body><br>
    <div class=container>
      <header class='row input-group dropdown show'>
        ${input.render({onkeypress: search, onfocus: showSuggestions, onblur: hideSuggestions})}

        <div class=dropdown-menu
          style='${state.displaySuggestions ? 'display: block;' : 'display: hidden;'} width: 92.3%;'>
          ${state.suggestions.map((x, i) => html`
            <button class=dropdown-item onclick=${selected.bind(null, i)}>${x}</button>
          `)}
        </div>

        <span class=input-group-btn>
          <button onclick=${add} class='btn btn-primary'>add</button>
        </span>
      </header><br>
      <section class=row>
        <ol class=list-group>
          ${state.ids.map((id, i) => {
            let node = state.nodes[id]
            return html`<li id=${window.Symbol()}
              class='list-group-item ${!node.flags.online ? 'list-group-item-danger' : ''}'
              draggable=true
              ondragstart=${pick.bind(null, i)}
              ondrop=${drop.bind(null, i)}
              ondragover=${x => false}
            >
              <b>${node.name}</b> (${id}),
              ${node.flags.online ? 'online' : 'offline'},
              ${node.clientcount} clients
              <button
                onclick=${remove.bind(null, i)}
                class='close float-right'
                style='margin-top: -2px;'
                type=button>×</button>
            </li>`
          })}
        </ol>
      </section>
      <footer>
        <small style='display: block; text-align: center; color: grey;'>
          <a href=https://github.com/pguth/ffs-monitor class=github>Github</a>
          has the source.
        </small>
      </footer>
    </div>
</body>`

  function hideSuggestions () {
    emit('toggleSuggestions', false)
  }

  function showSuggestions () {
    let input = document.querySelectorAll('header > input')[0].value
    if (input.length >= minSearchLengh) emit('toggleSuggestions', true)
  }

  function selected (i) {
    let selection = document.querySelectorAll('header > div > a')[i].value
    console.log('selection', selection)
  }

  function search ({keyCode}) {
    let newInput = String.fromCharCode(keyCode)
    let previousInput = document.querySelectorAll('header > input')[0].value
    let search = previousInput + newInput
    if (search.length < minSearchLengh) {
      emit('toggleSuggestions', false)
      return
    }
    emit('toggleSuggestions', true)
    emit('inputChange', search)
    socket.emit('search', search)
  }

  function pick (from, e) {
    e.dataTransfer.setData('text/plain', from)
  }
  function drop (to, e) {
    e.preventDefault()
    let from = e.dataTransfer.getData('text')
    emit('flip', {from, to})
  }

  function add () {
    let id = document.querySelector('header input').value
    emit('add', id)
  }
  function remove (i) {
    emit('remove', i)
  }
}

function uiStore (state, emitter) {
  state.suggestions = state.suggestions || []
  state.input = state.input || ''
  state.displaySuggestions = false

  emitter.on('toggleSuggestions', x => {
    state.displaySuggestions = x
    emitter.emit('render')
  })
  emitter.on('inputChange', x => {
    state.input = x
    emitter.emit('render')
  })
  emitter.on('suggestion', x => {
    state.suggestions = [...x.names, ...x.macs]
    emitter.emit('render')
  })
}

function nodeStore (state, emitter) {
  state.ids = state.ids || []
  state.nodes = state.nodes || {}

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
    let url = restUrl + '/v1/mac/' + id
    window.fetch(url).then(res => {
      res.json().then(node => {
        state.nodes[id] = node
        emitter.emit('render')
      })
    })
  })

  emitter.on('updateAll', x => {
    state.ids.forEach(id => emitter.emit('update', id))
  })

  emitter.on('flip', ({from, to}) => {
    let tmp = state.ids[to]
    state.ids[to] = state.ids[from]
    state.ids[from] = tmp
    emitter.emit('render')
  })
}
