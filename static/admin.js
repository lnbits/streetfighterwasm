const client = window.createLNbitsExtensionClient({
  extensionId: 'streetfighterwasm'
})

const app = Vue.createApp({
  data() {
    return {
      loading: false,
      saving: false,
      creating: false,
      deletingGameId: '',
      settings: {
        enabled: false,
        haircut: 0,
        walletId: ''
      },
      gameForm: {
        name: 'Paid StreetFighter match',
        joinAmount: 100
      },
      wallets: [],
      games: [],
      pagination: {
        sortBy: 'createdAt',
        descending: true,
        page: 1,
        rowsPerPage: 10,
        rowsNumber: 0
      },
      search: '',
      columns: [
        {name: 'name', label: 'Game', field: 'name', align: 'left', sortable: true},
        {name: 'joinAmount', label: 'Join sats', field: 'joinAmount', align: 'right', sortable: true},
        {name: 'players', label: 'Players', field: 'playersCount', align: 'left', sortable: false},
        {name: 'status', label: 'Status', field: 'status', align: 'left', sortable: true},
        {name: 'winner', label: 'Winner', field: 'winnerLnAddress', align: 'left', sortable: false},
        {name: 'actions', label: '', field: 'id', align: 'right', sortable: false}
      ]
    }
  },

  computed: {
    selectedWalletName() {
      return this.wallets.find(wallet => wallet.id === this.effectiveWalletId)?.name || ''
    },

    canSave() {
      return !this.settings.enabled || !!this.effectiveWalletId
    },

    canCreate() {
      return (
        this.settings.enabled &&
        this.effectiveWalletId &&
        this.gameForm.name &&
        Number(this.gameForm.joinAmount) > 0
      )
    },

    effectiveWalletId() {
      return this.settings.walletId || this.wallets[0]?.id || ''
    }
  },

  async mounted() {
    this.loading = true
    try {
      await Promise.all([this.fetchWallets(), this.fetchSettings(), this.fetchGames()])
    } finally {
      this.loading = false
    }
  },

  methods: {
    async fetchWallets() {
      try {
        const response = await client.listWallets()
        this.wallets = response.wallets || []
      } catch (error) {
        this.showError(error)
      }
    },

    async fetchSettings() {
      try {
        const response = await client.getSettings()
        this.settings = {...this.settings, ...(response.settings || {})}
        if (!this.settings.walletId && this.wallets.length) {
          this.settings.walletId = this.wallets[0].id
        }
      } catch (error) {
        this.showError(error)
      }
    },

    async saveSettings() {
      if (!this.canSave) return
      this.saving = true
      try {
        const response = await client.saveSettings({
          enabled: this.settings.enabled,
          walletId: this.effectiveWalletId,
          haircut: 0,
          walletName: this.selectedWalletName
        })
        this.settings = response.settings
        this.notify('StreetFighter settings saved.', 'positive')
      } catch (error) {
        this.showError(error)
      } finally {
        this.saving = false
      }
    },

    async createGame() {
      if (!this.canCreate) return
      this.creating = true
      try {
        await this.ensureBackgroundPaymentGrant()
        await client.createGame({
          name: this.gameForm.name,
          joinAmount: Number(this.gameForm.joinAmount)
        })
        this.notify('StreetFighter match created.', 'positive')
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      } finally {
        this.creating = false
      }
    },

    async ensureBackgroundPaymentGrant() {
      const joinAmount = Math.floor(Number(this.gameForm.joinAmount))
      const maximumPayout = joinAmount * 2

      await client.requestBackgroundPaymentPermission({
        walletId: this.effectiveWalletId,
        maxAmount: maximumPayout,
        destinationPolicy: 'external_allowed'
      })
    },

    async fetchGames(props = {}) {
      const pagination = props.pagination || this.pagination
      try {
        const response = await client.listGames({
          page: pagination.page,
          rowsPerPage: pagination.rowsPerPage,
          sortBy: pagination.sortBy,
          descending: pagination.descending,
          search: this.search
        })
        this.games = response.games || []
        this.pagination = {...pagination, rowsNumber: response.total || 0}
      } catch (error) {
        this.showError(error)
      }
    },

    publicUrl(game) {
      return new URL(`/ext/streetfighterwasm/games/${encodeURIComponent(game.id)}`, window.location.href).href
    },

    async copyGame(game) {
      await navigator.clipboard?.writeText(this.publicUrl(game)).then(() => {
        this.notify('Match link copied.', 'positive')
      }).catch(error => {
        console.warn('[streetfighterwasm admin] failed to copy match link', error)
      })
    },

    async settleGame(game) {
      try {
        await client.settleGame(game.id)
        this.notify('Winner payout sent.', 'positive')
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      }
    },

    async deleteGame(game) {
      if (game.status === 'completed' && game.payoutPending) {
        this.notify('Settle the pending payout before deleting this match.', 'warning')
        return
      }
      const confirmed = await this.confirmAction({
        title: 'Delete Match',
        message: `Delete "${game.name}"? This removes the match and players.`,
        okLabel: 'Delete',
        okColor: 'negative'
      })
      if (!confirmed) return
      this.deletingGameId = game.id
      try {
        await client.deleteGame(game.id)
        this.notify('StreetFighter match deleted.', 'positive')
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      } finally {
        this.deletingGameId = ''
      }
    },

    confirmAction({title, message, okLabel = 'OK', okColor = 'primary'}) {
      return new Promise(resolve => {
        Quasar.Dialog.create({
          dark: true,
          title,
          message,
          cancel: true,
          persistent: true,
          ok: {
            label: okLabel,
            color: okColor
          }
        })
          .onOk(() => resolve(true))
          .onCancel(() => resolve(false))
          .onDismiss(() => resolve(false))
      })
    },

    statusLabel(game) {
      if (game.status === 'completed' && game.payoutPending) return 'Payout pending'
      if (game.status === 'completed') return 'Complete'
      if (game.status === 'active') return 'Active'
      return 'Waiting'
    },

    statusColor(game) {
      if (game.status === 'completed' && game.payoutPending) return 'warning'
      if (game.status === 'completed') return 'positive'
      if (game.status === 'active') return 'primary'
      return 'grey'
    },

    notify(message, type = 'info') {
      client.notify(message, type).catch(() => {
        Quasar.Notify.create({type, message})
      })
    },

    showError(error) {
      const message = error?.message || String(error)
      this.notify(message, 'negative')
    }
  },

  render() {
    const h = Vue.h
    const q = name => Quasar[name]
    return h('main', {class: 'admin-shell q-pa-md'}, [
      h('header', {class: 'row items-center q-gutter-md q-mb-md'}, [
        h('div', {class: 'streetfighter-mark'}, 'SF'),
        h('div', [
          h('h1', {class: 'text-h4 text-weight-bold q-my-none'}, 'StreetFighter'),
          h('p', {class: 'text-subtitle2 text-grey-5 q-my-none'}, 'Paid public fights.')
        ])
      ]),
      h('div', {class: 'row q-col-gutter-md'}, [
        h('div', {class: 'col-12 col-md-5 q-gutter-y-md'}, [
          h(q('QCard'), {dark: true}, () => [
            h(q('QCardSection'), () => [
              h('h2', {class: 'text-h6 text-weight-bold q-my-none q-mb-md'}, 'Settings'),
              h(q('QToggle'), {
                modelValue: this.settings.enabled,
                'onUpdate:modelValue': value => (this.settings.enabled = value),
                label: 'Enable StreetFighter matches',
                color: 'primary'
              }),
              h(q('QSelect'), {
                class: 'q-mt-md',
                modelValue: this.effectiveWalletId,
                'onUpdate:modelValue': value => (this.settings.walletId = value),
                options: this.wallets.map(wallet => ({label: wallet.name, value: wallet.id})),
                label: 'Wallet',
                filled: true,
                dense: true,
                dark: true,
                optionsDark: true,
                popupContentClass: 'streetfighter-menu',
                emitValue: true,
                mapOptions: true
              }),
              h(q('QBtn'), {
                class: 'q-mt-md',
                color: 'primary',
                loading: this.saving,
                disable: !this.canSave,
                onClick: this.saveSettings
              }, () => 'Save Settings')
            ])
          ]),
          h(q('QCard'), {dark: true}, () => [
            h(q('QCardSection'), () => [
              h('h2', {class: 'text-h6 text-weight-bold q-my-none q-mb-md'}, 'New Match'),
              h(q('QInput'), {
                modelValue: this.gameForm.name,
                'onUpdate:modelValue': value => (this.gameForm.name = value),
                label: 'Title',
                filled: true,
                dense: true,
                dark: true
              }),
              h(q('QInput'), {
                class: 'q-mt-sm',
                modelValue: this.gameForm.joinAmount,
                'onUpdate:modelValue': value => (this.gameForm.joinAmount = value),
                type: 'number',
                label: 'Join sats',
                filled: true,
                dense: true,
                dark: true,
                min: 1
              }),
              h(q('QBtn'), {
                class: 'q-mt-md',
                color: 'primary',
                loading: this.creating,
                disable: !this.canCreate,
                onClick: this.createGame
              }, () => 'Create Match')
            ])
          ])
        ]),
        h('div', {class: 'col-12 col-md-7'}, [
          h(q('QCard'), {dark: true}, () => [
            h(q('QCardSection'), () => [
              h('div', {class: 'row items-center q-col-gutter-md q-mb-md'}, [
                h('div', {class: 'col'}, [
                  h('h2', {class: 'text-h6 text-weight-bold q-my-none'}, 'Matches')
                ]),
                h('div', {class: 'col-12 col-sm-5'}, [
                  h(q('QInput'), {
                    modelValue: this.search,
                    'onUpdate:modelValue': value => (this.search = value),
                    debounce: 350,
                    placeholder: 'Search',
                    dense: true,
                    filled: true,
                    dark: true,
                    onChange: () => this.fetchGames()
                  })
                ])
              ]),
              h(q('QTable'), {
                dark: true,
                flat: true,
                rows: this.games,
                columns: this.columns,
                rowKey: 'id',
                pagination: this.pagination,
                loading: this.loading,
                'onRequest': this.fetchGames
              }, {
                'body-cell-status': props => h(q('QTd'), {props}, () => [
                  h(q('QBadge'), {color: this.statusColor(props.row)}, () => this.statusLabel(props.row))
                ]),
                'body-cell-players': props => h(q('QTd'), {props}, () => `${props.row.playersCount} / 2`),
                'body-cell-actions': props => h(q('QTd'), {props, class: 'q-gutter-xs'}, () => [
                  h(q('QBtn'), {
                    flat: true,
                    round: true,
                    dense: true,
                    icon: 'content_copy',
                    onClick: () => this.copyGame(props.row)
                  }),
                  h(q('QBtn'), {
                    flat: true,
                    round: true,
                    dense: true,
                    icon: 'open_in_new',
                    type: 'a',
                    href: this.publicUrl(props.row),
                    target: '_blank'
                  }),
                  props.row.payoutPending
                    ? h(q('QBtn'), {
                        flat: true,
                        round: true,
                        dense: true,
                        color: 'positive',
                        icon: 'payments',
                        onClick: () => this.settleGame(props.row)
                      })
                    : null,
                  h(q('QBtn'), {
                    flat: true,
                    round: true,
                    dense: true,
                    color: 'negative',
                    icon: 'delete',
                    loading: this.deletingGameId === props.row.id,
                    onClick: () => this.deleteGame(props.row)
                  })
                ])
              })
            ])
          ])
        ])
      ])
    ])
  }
})

app.use(Quasar)
app.mount('#streetfighter-admin-app')
