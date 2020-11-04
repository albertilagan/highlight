import { EventType, addCustomEvent, record } from 'rrweb';
import { detect } from 'detect-browser';
import {
  InMemoryCache,
  gql,
  ApolloClient,
  NormalizedCacheObject,
} from '@apollo/client/core';
import { eventWithTime } from 'rrweb/typings/types';

class Logger {
  debug: boolean;
  constructor(debug: boolean) {
    this.debug = debug;
  }
  log(...data: any[]) {
    if (this.debug) {
      console.log.apply(console, data);
    }
  }
}

(window as any).Highlight = class Highlight {
  organizationID: number;
  client: ApolloClient<NormalizedCacheObject>;
  events: eventWithTime[];
  messages: ConsoleMessage[];
  sessionID: number;
  ready: boolean;
  logger: Logger;

  constructor(debug: boolean) {
    // If debug is set to false, disable all console
    this.ready = false;
    this.logger = new Logger(debug);
    this.client = new ApolloClient({
      uri: `${process.env.BACKEND_URI}/client`,
      cache: new InMemoryCache(),
      credentials: 'include',
    });
    this.organizationID = 0;
    this.sessionID = 0;
    this.events = [];
    this.messages = [];
  }

  async identify(user_identifier: string, user_object = {}) {
    await this.client.mutate({
      mutation: gql`
        mutation identifySession(
          $session_id: ID!
          $user_identifier: String!
          $user_object: Any
        ) {
          identifySession(
            session_id: $session_id
            user_identifier: $user_identifier
            user_object: $user_object
          )
        }
      `,
      variables: {
        session_id: this.sessionID,
        user_identifier: user_identifier,
        user_object: user_object,
      },
    });
    this.logger.log(
      `Identify (${user_identifier}) w/ obj: ${JSON.stringify(user_object)} @ ${
        process.env.BACKEND_URI
      }`
    );
  }

  async addProperties(properties_obj = {}) {
    await this.client.mutate({
      mutation: gql`
        mutation addProperties($session_id: ID!, $properties_object: Any) {
          addProperties(
            session_id: $session_id
            properties_object: $properties_object
          )
        }
      `,
      variables: {
        session_id: this.sessionID,
        properties_object: properties_obj,
      },
    });
    this.logger.log(
      `AddProperties to session (${this.sessionID}) w/ obj: ${JSON.stringify(
        properties_obj
      )} @ ${process.env.BACKEND_URI}`
    );
  }

  async initialize(organizationID: number) {
    const browser = detect();
    if (!organizationID) {
      console.error('empty organization_id!');
      return;
    }
    this.organizationID = organizationID;
    let response = await fetch(`https://geolocation-db.com/json/`);
    let data = await response.json();
    let details = JSON.stringify({ ...data, browser });
    let gr = await this.client.mutate({
      mutation: gql`
        mutation initializeSession($organization_id: ID!, $details: String!) {
          initializeSession(
            organization_id: $organization_id
            details: $details
          ) {
            id
            user_id
            organization_id
            details
          }
        }
      `,
      variables: {
        organization_id: this.organizationID,
        details: details,
      },
    });
    this.sessionID = gr.data.initializeSession.id;
    this.logger.log(
      `Loaded Highlight
Remote: ${process.env.BACKEND_URI}
Org: ${this.organizationID}
Session Data: 
`,
      gr.data
    );
    setInterval(() => {
      this._save();
    }, 5 * 1000);
    const emit = (event: eventWithTime) => {
      this.events.push(event);
    };
    emit.bind(this);
    record({
      recordCanvas: true,
      emit,
    });

    // TODO: probably get rid of this.
    const highlightThis = this;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (data) {
      setTimeout(() => {
        var obj: any;
        try {
          obj = JSON.parse(data?.toString() ?? '');
        } catch (e) {
          return;
        }
        if (obj.type === 'track') {
          const properties: { [key: string]: string } = {};
          properties['segment-event'] = obj.event;
          highlightThis.logger.log(
            `Adding (${JSON.stringify(properties)}) @ ${
              process.env.BACKEND_URI
            }, org: ${highlightThis.organizationID}`
          );
          addCustomEvent<string>(
            'Segment',
            JSON.stringify({
              event: obj.event,
              properties: obj.properties,
            })
          );
          highlightThis.addProperties(properties);
        }
      }, 100);
      send.call(this, data);
    };
    if (document.referrer) {
      addCustomEvent<string>('Referrer', document.referrer);
      highlightThis.addProperties({ referrer: document.referrer });
    }
    initUrlListeners((url: string) => {
      addCustomEvent<string>('Navigate', url);
      highlightThis.addProperties({ 'visited-url': url });
    });
    initConsoleListeners((c: ConsoleMessage) => highlightThis.messages.push(c));
    this.ready = true;
  }

  // Reset the events array and push to a backend.
  async _save() {
    if (!this.sessionID) {
      return;
    }
    const resources = performance
      .getEntriesByType('resource')
      .filter(
        (r) =>
          !r.name.includes(
            process.env.BACKEND_URI ?? 'https://api.highlight.run'
          )
      );
    const resourcesString = JSON.stringify({ resources: resources });
    const messagesString = JSON.stringify({ messages: this.messages });
    const eventsString = JSON.stringify({ events: this.events });
    this.logger.log(
      `Sending: ${this.events.length} events, ${this.messages.length} messages, ${resources.length} network resources \nTo: ${process.env.BACKEND_URI}\nOrg: ${this.organizationID}`
    );
    this.events = [];
    this.messages = [];
    performance.clearResourceTimings();
    await this.client.mutate({
      mutation: gql`
        mutation PushPayload(
          $session_id: ID!
          $events: String!
          $messages: String!
          $resources: String!
        ) {
          pushPayload(
            session_id: $session_id
            events: $events
            messages: $messages
            resources: $resources
          )
        }
      `,
      variables: {
        session_id: this.sessionID,
        events: eventsString,
        messages: messagesString,
        resources: resourcesString,
      },
    });
  }
};

// taken from: https://stackoverflow.com/questions/6390341/how-to-detect-if-url-has-changed-after-hash-in-javascript/52809105#52809105
const initUrlListeners = (callback: (url: string) => void) => {
  callback(window.location.href);
  history.pushState = ((f) =>
    function pushState() {
      // @ts-ignore
      var ret = f.apply(this, arguments);
      window.dispatchEvent(new Event('pushstate'));
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    })(history.pushState);

  history.replaceState = ((f) =>
    function replaceState() {
      // @ts-ignore
      var ret = f.apply(this, arguments);
      window.dispatchEvent(new Event('replacestate'));
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    })(history.replaceState);

  window.addEventListener('popstate', () => {
    window.dispatchEvent(new Event('locationchange'));
  });

  window.addEventListener('locationchange', function () {
    callback(window.location.href);
  });
};

declare global {
  interface Console {
    defaultLog: any;
    defaultError: any;
    defaultWarn: any;
    defaultDebug: any;
  }
}

type ConsoleMessage = {
  value: string;
  time: number;
  type: string;
};

// taken from: https://stackoverflow.com/questions/19846078/how-to-read-from-chromes-console-in-javascript
const initConsoleListeners = (callback: (c: ConsoleMessage) => void) => {
  console.defaultLog = console.log.bind(console);
  console.log = function (text: string) {
    callback({
      type: 'Log',
      time: Date.now(),
      value: text,
    });
    console.defaultLog.apply(console, arguments);
  };
  console.defaultError = console.error.bind(console);
  console.error = function (text: string) {
    callback({
      type: 'Error',
      time: Date.now(),
      value: text,
    });
    console.defaultError.apply(console, arguments);
  };
  console.defaultWarn = console.warn.bind(console);
  console.warn = function (text: string) {
    callback({
      type: 'Warn',
      time: Date.now(),
      value: text,
    });
    console.defaultWarn.apply(console, arguments);
  };
  console.defaultDebug = console.debug.bind(console);
  console.debug = function (text: string) {
    callback({
      type: 'Debug',
      time: Date.now(),
      value: text,
    });
    console.defaultDebug.apply(console, arguments);
  };
};
