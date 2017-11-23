import { app, h } from 'hyperapp';
import './styles/client.css';
import { div } from '@hyperapp/html';
import { Header } from './partials';
import state, { IAppState, IError, Page } from './initialState';
import actions, { IActions } from './actions';
import botForm from './modules/botFormModule';
import syncActionsAndInjectEmitter from './enhancer';
import { isValidSetupAndPlayersState } from './helpers';
import singleBattle from './pages/singleBattle';
import multipleBattle from './pages/multipleBattle';
import docs from './pages/docs';

const pages = {
  [Page.singleBattle]: singleBattle,
  [Page.multipleBattle]: multipleBattle,
  [Page.docs]: docs
};

const actionsSyncedWithStorage = [
  'addPlayer',
  'removePlayer',
  'recordWin',
  'setup.updateSpeed',
  'setup.up',
  'setup.down',
  'changePage'
];
const stateSyncedWithStorage = ['setup', 'players', 'currentPage'];

const enhancedApp = syncActionsAndInjectEmitter(app, {
  syncedState: stateSyncedWithStorage,
  syncedActions: actionsSyncedWithStorage,
  stateValidator: isValidSetupAndPlayersState,
  disablePersistence: true
});
import marked from 'marked';

const DOCS_PATH = './docs.md';

const handleErrors = (res: any) => {
  if (!res.ok) throw Error(res.statusText);
  return res;
};

const fetchMarkdown = () =>
  fetch(DOCS_PATH)
    .then(handleErrors)
    .then(data => data.text())
    .then(marked);

enhancedApp(
  {
    state,
    actions,
    init: (state: IAppState, actions: IActions): void => {
      actions.updateGameStatus();
      actions.log();
      fetchMarkdown().then(actions.setDocs);
    },
    events: {
      'cube:resize': (state: IAppState, actions: IActions, data: any): void => {
        state.cube.resize(data.edgeLength);
      },
      error: (_s: IAppState, { showError }: IActions, data: IError) =>
        showError(data)
    },
    modules: { botForm },
    view: (state: IAppState, actions: IActions) =>
      div({ className: 'container' }, [
        Header(state, actions.changePage),
        pages[state.currentPage](state, actions)
      ])
  },
  document.getElementById('app')
);
