// @flow

import _ from 'lodash';
import React, { Component } from 'react';
import { Text, Navigator, TouchableHighlight, AppRegistry, ToolbarAndroid, StyleSheet, ListView, View, TextInput, BackAndroid, StatusBar, TouchableOpacity, RefreshControl, AppState, Share, ToastAndroid } from 'react-native';
import { MenuContext } from 'react-native-popup-menu';
import ShareMenu from 'react-native-share-menu';
import CustomTransitions from './util/CustomTransitions';
import NoteList from './components/NoteList';
import NoteEdit from './components/NoteEdit';
import { makeDropboxRequest, makeDropboxDownloadRequest, makeDropboxUploadRequest } from './dropbox';

function loaderWrapper(startFn, endFn, delay) {
  let started = false;
  const timeout = setTimeout(() => {
    started = true;
    startFn();
  }, delay);

  return (res) => {
    if (started) {
      endFn();
    } else {
      clearTimeout(timeout);
    }
    return res;
  };
}

var _navigator;

type Route = Object;
type Path = string;
type Note = Object;

export default class App extends Component {
  state: {
      items: Array<Object> | null;
      isRefreshing: number;
      path: string;
      note: Note;
      isLoading: boolean;
      sharedText: string;
      searchQuery: string;
  };
  menuContext: Object | null;
  folderCache: Object;
  dirtyNote: {
    note: Note;
    title: string | typeof undefined;
    content: string | typeof undefined;
  } | null;

  constructor() {
    super();

    this.state = {
      items: null,
      isRefreshing: 0, // refreshing folder list
      path: '',
      note: {},
      isLoading: false, // loading note content
      searchQuery: '',
      sharedText: '',
    };
    this.dirtyNote = null;
    this.folderCache = {};
    this.listFolder(this.state.path);

    BackAndroid.addEventListener('hardwareBackPress', () => {
      this.saveNote();
      if (this.menuContext && this.menuContext.isMenuOpen()) {
        this.menuContext.closeMenu();
        return false;
      }
      if (_navigator.getCurrentRoutes().length <= 1) {
        if (this.state.sharedText) {
          this.setState({ sharedText: '' });
        }
        return false;
      }
      _navigator.pop();
      return true;
    });
  }

  componentWillMount() {
    ShareMenu.getSharedText((text :string) => {
      if (text && text.length) {
        this.setState({
          sharedText: text
        });
      }
    })
  }

  componentDidMount() {
    AppState.addEventListener('change', this.handleAppStateChange);
  }

  componentWillUnmount() {
    AppState.removeEventListener('change', this.handleAppStateChange);
  }

  render () {
    return (
      <MenuContext style={{flex: 1}} ref={(el) => this.menuContext = el}>
        <StatusBar
          backgroundColor='#25796A'
          barStyle='light-content'
        />
        <Navigator
          style={styles.container}
          tintColor='#2E9586'
          initialRoute={{id: 'NoteList', path: ''}}
          renderScene={this.navigatorRenderScene}
          configureScene={(route, routeStack) =>
            // Navigator.SceneConfigs.PushFromRight
            CustomTransitions.NONE
          }
          onWillFocus={this.onWillFocus}
        />
      </MenuContext>
    );
  }

  navigatorRenderScene = (route: Route, navigator: Navigator) => {
    _navigator = navigator;
    switch (route.id) {
      case 'NoteList':
        return (
          <NoteList
            navigator={navigator}
            path={route.path}
            addNote={this.addNote}
            addFolder={this.addFolder}
            editNote={this.editNote}
            openMenu={this.openMenu}
            onRefresh={this.onRefreshControl}
            isRefreshing={this.state.isRefreshing > 0}
            items={this.state.items}
            styles={styles}
            onSearchChange={this.onSearchChange}
            onSearchToggle={this.onSearchToggle}
            message={!!this.state.sharedText && <Text style={styles.toolbarMessage}>Select or create note to add shared text</Text>}
          />
        );
      case 'NoteSearch':
        return (
          <NoteList
            navigator={navigator}
            path={route.path}
            addNote={this.addNote}
            addFolder={this.addFolder}
            editNote={this.editNote}
            openMenu={this.openMenu}
            onRefresh={this.onRefreshControl}
            isRefreshing={this.state.isRefreshing > 0}
            items={this.state.items}
            styles={styles}
            onSearchChange={this.onSearchChange}
            onSearchToggle={this.onSearchToggle}
            isSearching={true}
          />
        );
      case 'NoteEdit': {
        const note = {
          ...this.state.note,
          ...this.dirtyNote,
        };
        return (
          <NoteEdit
            navigator={navigator}
            note={note}
            updateNote={this.updateNote}
            saveNote={this.saveNote}
            deleteNote={this.deleteNote}
            shareNote={this.shareNote}
            openMenu={this.openMenu}
            styles={styles}
            isLoading={this.state.isLoading}
          />
        );
      }
    }
  }

  onWillFocus = (route: Route) => {
    if (route.id === 'NoteList') {
      this.setState({
        path: route.path,
        items: this.folderCache[route.path] || this.state.items
      });
      this.listFolder(route.path);
    }
  }

  handleAppStateChange = (currentAppState: string) => {
    const currentRoute = _navigator.getCurrentRoutes().slice(-1)[0];
    if (currentRoute && currentRoute.id === 'NoteList' && currentAppState === 'active') {
      this.listFolder(this.state.path);
    }
    if (currentRoute && currentRoute.id === 'NoteEdit' && currentAppState === 'active') {
      this.loadNote(this.state.note.path_display);
    }
    if (currentRoute && currentRoute.id === 'NoteEdit' && (currentAppState === 'inactive' || currentAppState === 'background')) {
      this.saveNote();
    }
  }

  addNote = () => {
    if (this.state.sharedText) {
      this.updateNote({
        content: this.state.sharedText
      });
    }
    this.setState({
      note: {
        title: '',
        content: this.state.sharedText,
      },
      isLoading: false,
      sharedText: ''
    });
    _navigator.push({
      id: 'NoteEdit'
    });
  }

  addFolder = async (path: Path) => {
    await this.requestRetryWrapper(() => makeDropboxRequest('files/create_folder', { path }));
    this.listFolder(this.state.path);
  }

  saveNote = async () => {
    const note = this.dirtyNote;
    if (note) {
      this.dirtyNote = null;
      const oldNote = note.note || {};
      let filePath = oldNote.path_display;
      if (oldNote.title && note.title && note.title !== oldNote.title) {
        filePath = this.state.path + '/' + (note.title || 'Untitled.md');
        if (!filePath.match(/\.[a-zA-Z0-9]+$/)) {
          filePath += '.md';
        }
        await this.requestRetryWrapper(() => makeDropboxRequest('files/move', {
          from_path: oldNote.path_display,
          to_path: filePath,
          autorename: true
        }));
      }
      if (!filePath) {
        filePath = this.state.path + '/' + (note.title || 'Untitled.md');
        if (!filePath.match(/\.[a-zA-Z0-9]+$/)) {
          filePath += '.md';
        }
      }

      const mode = oldNote.rev
        ? { ".tag": "update", "update": oldNote.rev } // overwrite only if rev matches
        : 'add';

      const result = await this.requestRetryWrapper(() => makeDropboxUploadRequest({
         path: filePath,
         mode,
         autorename: true,
      }, note.content));

      this.setState({
        note: this.transformNote(result)
      });

      // if it is a new file then refresh
      if (!oldNote.path_display || (oldNote.title && result.title && result.title !== oldNote.title)) {
        this.onRefresh();
      }
    }
  }

  updateNote = (note: Note) => {
    this.dirtyNote = {
      ...this.dirtyNote,
      ...note
    };
  }

  deleteNote = async (note: Note) => {
    await this.requestRetryWrapper(() => makeDropboxRequest('files/delete', { path: note.path_display }));
    this.onRefresh();
  }

  loadNote = async (path: Path) => {
    this.setState({
      note: {
        title: path.split('/').slice(-1)[0],
        content: 'Loading...',
      },
      isLoading: true,
    });
    const item = await this.requestRetryWrapper(() => makeDropboxDownloadRequest({ path }))
    const note = this.transformNote(item);
    if (this.state.sharedText) {
      note.content += '\n\n' + this.state.sharedText;
      this.updateNote({
        note,
        content: note.content
      });
    }
    this.setState({
      isLoading: false,
      note: note,
      sharedText: ''
    });
  }

  transformNote(item: Object): Note {
    return {
      id: item.id,
      title: item.name,
      path_display: item.path_display,
      rev: item.rev,
      content: item.fileBinary,
    }
  }

  editNote = (path: Path) => {
    this.loadNote(path);
    _navigator.push({
      id: 'NoteEdit',
    });
  }

  openMenu = (name: string) => {
    if (this.menuContext) {
      this.menuContext.openMenu(name);
    }
  }

  onRefresh = () => {
    this.listFolder(this.state.path);
  }

  onRefreshControl = () => {
    this.setState({ isRefreshing: this.state.isRefreshing + 1 });
    this.listFolder(this.state.path)
      .then(() => this.setState({ isRefreshing: this.state.isRefreshing - 1 }));
  }

  listFolder = async (path: Path) => {
    const response = await this.requestRetryWrapper(() => makeDropboxRequest('files/list_folder', { path }));

    const items = response.entries.map(item => ({
      id: item.id,
      folder: item['.tag'] === 'folder',
      title: item.name,
      path_display: item.path_display,
      rev: item.rev
    }));

    this.folderCache[path] = items;
    this.setState({ items });
  }

  async requestRetryWrapper(fn) {
    let delay = 2000;
    let numRetries = 5;
    let response = null;
    const loaderFn = this.loaderWrapper();

    while (numRetries >= 0) {
      try {
        response = await fn();
        break;
      } catch (e) {
        ToastAndroid.showWithGravity(`Response error, retrying in ${Math.round(delay/1000)}s`, ToastAndroid.SHORT, ToastAndroid.BOTTOM);
        await new Promise((resolve) => setTimeout(resolve), delay);
        numRetries -= 1;
        delay = delay * 2;
      }
    }

    loaderFn();
    return response;
  }

  requestWrapper(fn) {
    return fn()
      .catch((error) => {
        console.error(error);
      })
      .then(this.loaderWrapper());
  }

  loaderWrapper(delay:number=500) {
    return loaderWrapper(
      () => this.setState({ isRefreshing: this.state.isRefreshing + 1 }),
      () => this.setState({ isRefreshing: this.state.isRefreshing - 1 }),
      delay
    );
  }

  _doSearch = _.debounce((query) => {
    const response = this.requestRetryWrapper(() => makeDropboxRequest('files/search', {
      path: "",
      query,
      start: 0,
      max_results: 20,
      // "mode": "filename"
    }));

    const items = response.matches.map(match => {
      const item = match.metadata;
      return {
        id: item.id,
        folder: item['.tag'] === 'folder',
        title: item.name,
        path_display: item.path_display,
        rev: item.rev
      }
    });

    // this.folderCache[path] = items;
    this.setState({ items });
  }, 300)

  onSearchChange = (text: string | Object) => {
    if (typeof text === 'object') {
      // search bar returns object when x is tapped
      text = '';
    }
    this.setState({
      searchQuery: text
    });
    this._doSearch(text);
  }

  onSearchToggle = () => {
    const currentRoute = _navigator.getCurrentRoutes().slice(-1)[0];
    if (currentRoute.id !== 'NoteSearch') {
      _navigator.push({ id: 'NoteSearch' });
    }
  }

  shareNote = (note: Note) => {
    Share.share({
      title: note.title,
      message: note.content
    }).catch(e => console.error(e));
  }
}

const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: '#F5F5F5',
    },
    toolbar: {
      height: 56,
      backgroundColor: '#2E9586'
    },
    toolbarMessage: {
      height: 56,
      textAlign: 'center',
      textAlignVertical: 'center',
      color: 'white',
      backgroundColor: '#4BAB9E'
    },
    rowContainer: {
      height: 56,
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
    },
    rowIcon: {
        fontSize: 20,
        textAlign: 'right',
        color: 'gray',
        margin: 10,
        marginLeft: 15,
    },
    rowDetailsContainer: {
        flex: 1,
    },
    rowTitle: {
        fontSize: 15,
        textAlign: 'left',
        marginTop: 15,
        marginBottom: 15,
        marginRight: 10,
        color: '#000000'
    },
    separator: {
        height: 1,
        backgroundColor: '#CCCCCC'
    },
    emptyFolderText: {
      flex: 1,
      textAlign: 'center',
      textAlignVertical: 'center',
      fontSize: 20
    },
    actionButtonIcon: {
      fontSize: 20,
      height: 22,
      color: 'white',
    },
    menuOption: {
      height: 48,
      paddingLeft: 16,
      paddingTop: 14,
    },
    menuOptionText: {
      // fontSize: 16,
      color: 'rgba(0,0,0,0.87)',
    },
});
