import FrameListener from './FrameListener';

export default class Ticker {
    listeners: FrameListener[] = [];

    constructor() {
        this.listeners = [];
    }

    register(component: FrameListener) {
        this.listeners.push(component);
    }

    unregister(component: FrameListener) {
        const idx = this.listeners.indexOf(component);
        if (idx !== -1) {
            this.listeners.splice(idx, 1);
        }
    }

    frame() {
        for (const component of this.listeners) {
            if (component) {
                component.frame();
            }
        }
    }
}

export interface TickerProps {
    ticker: Ticker;
}
