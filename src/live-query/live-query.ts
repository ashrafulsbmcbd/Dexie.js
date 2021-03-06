import { isAsyncFunction, keys } from "../functions/utils";
import { globalEvents } from "../globals/global-events";
import {
  decrementExpectedAwaits,
  incrementExpectedAwaits,
  newScope,
  PSD,
  usePSD,
} from "../helpers/promise";
import { ObservabilitySet } from "../public/types/db-events";
import {
  Observable as IObservable,
  Subscription,
} from "../public/types/observable";
import { Observable } from "../classes/observable/observable";
import { extendObservabilitySet } from './extend-observability-set';

export function liveQuery<T>(querier: () => T | Promise<T>): IObservable<T> {
  return new Observable<T>(({ start, next, error }) => {
    const scopeFuncIsAsync = isAsyncFunction(querier);
    function execute(subscr: ObservabilitySet) {
      if (scopeFuncIsAsync) {
        incrementExpectedAwaits();
      }
      const exec = () => newScope(querier, { subscr, trans: null });
      const rv = PSD.trans
        ? // Ignore current transaction if active when calling subscribe().
          usePSD(PSD.transless, exec)
        : exec();
      if (scopeFuncIsAsync) {
        (rv as Promise<any>).then(
          decrementExpectedAwaits,
          decrementExpectedAwaits
        );
      }
      return rv;
    }

    let closed = false;

    let accumMuts: ObservabilitySet = {};
    let currentObs: ObservabilitySet = {};

    const subscription: Subscription = {
      get closed() {
        return closed;
      },
      unsubscribe: () => {
        closed = true;
        globalEvents.txcommitted.unsubscribe(mutationListener);
      },
    };

    start && start(subscription); // https://github.com/tc39/proposal-observable

    let querying = false,
      startedListening = false;

    function shouldNotify() {
      for (const db of keys(currentObs)) {
        const mutDb = accumMuts[db];
        if (mutDb) {
          const obsDb = currentObs[db];
          for (const table of keys(obsDb)) {
            const mutTable = mutDb[table];
            const obsTable = obsDb[table];
            if (mutTable === true) {
              if (obsTable) return true;
              else continue;
            }
            if (obsTable === true) {
              if (mutTable) return true;
              else continue;
            }
            if (
              mutTable &&
              mutTable.keys &&
              obsTable.keys.some((key) =>
                mutTable.keys.some((mKey) => {
                  try {
                    return obsTable.cmp!(key, mKey) === 0;
                  } catch (_) {
                    return false;
                  }
                })
              )
            ) {
              return true;
            }
          }
        }
      }
      return false;
    }

    const mutationListener = (parts: ObservabilitySet) => {
      extendObservabilitySet(accumMuts, parts);
      if (shouldNotify()) {
        doQuery();
      }
    };

    const doQuery = () => {
      if (querying || closed) return;
      accumMuts = {};
      const subscr: ObservabilitySet = {};
      const ret = execute(subscr);
      if (!startedListening) {
        globalEvents("txcommitted", mutationListener);
        startedListening = true;
      }
      querying = true;
      Promise.resolve(ret).then(
        (result) => {
          querying = false;
          if (closed) return;
          if (shouldNotify()) {
            // Mutations has happened while we were querying. Redo query.
            doQuery();
          } else {
            accumMuts = {};
            // Update what we are subscribing for based on this last run:
            currentObs = subscr;
            next && next(result);
          }
        },
        (err) => {
          querying = false;
          error && error(err);
          subscription.unsubscribe();
        }
      );
    };

    doQuery();
    return subscription;
  });
}
