import * as React from 'react';
import {map} from 'lodash';
import DebugData, {
    renameObject,
    getObjectName,
    locateObject
} from '../../../../DebugData';
import {SceneGraphNode} from '../../sceneGraph/SceneGraphNode';
import {mapComportementArg} from '../../scripts/text/listing';
import {makeObjectsNode} from '../node_factories/objects';
import { getEntities, loadEntities } from '../../../model/browser/entitities';
import Actor from '../../../../../../game/Actor';
import { getParams } from '../../../../../../params';

const isLBA1 = getParams().game === 'lba1';

const ActorNode = {
    dynamic: true,
    needsData: true,
    allowRenaming: actor => actor.index > (isLBA1 ? 0 : 1),
    rename: (actor, newName) => {
        renameObject('actor', actor.props.sceneIndex, actor.index, newName);
    },
    ctxMenu: [
        {
            name: 'Locate',
            onClick: (_component, actor) => locateObject(actor)
        }
    ],
    name: actor => getObjectName('actor', actor.props.sceneIndex, actor.index),
    icon: actor => `editor/icons/${actor.props.flags.isSprite ? 'sprite' : 'model'}.svg`,
    props: actor => [
        {
            id: 'index',
            value: actor.index,
            render: value => <span>#{value}</span>
        },
        {
            id: 'visible',
            value: actor.isVisible,
            render: (value) => {
                const onClick = () => {
                    actor.isVisible = !actor.isVisible;
                    if (actor.threeObject) {
                        actor.threeObject.visible = actor.isVisible;
                    }
                };
                return <img
                    src={`editor/icons/${value ? 'visible' : 'hidden'}.svg`}
                    onClick={onClick}
                    style={{cursor: 'pointer', width: 14, height: 14}}
                />;
            }
        }
    ],
    childProps: [
        {
            id: 'entity',
            name: 'Entity',
            value: (actor) => {
                if (actor.props.entityIndex === -1) {
                    return '<no-entity>';
                }
                if (DebugData.metadata.entities[actor.props.entityIndex]) {
                    const name = DebugData.metadata.entities[actor.props.entityIndex];
                    return `${name} (${actor.props.entityIndex})`;
                }
                return `entity_${actor.props.entityIndex}`;
            },
            onClick: (_entity, component) => {
                const actor = component.props.data.context;
                component.props.editor.switchEditor('model', {
                    rootState: {
                        entity: actor.props.entityIndex,
                        body: 0,
                        anim: 0
                    }
                });
            },
            icon: () => 'editor/icons/entity.svg'
        },
        {
            id: 'body',
            name: 'Body',
            value: (actor) => {
                if (actor.props.bodyIndex === -1) {
                    return '<no-body>';
                }
                if (DebugData.metadata.bodies[actor.props.bodyIndex]) {
                    return DebugData.metadata.bodies[actor.props.bodyIndex];
                }
                return `body_${actor.props.bodyIndex}`;
            },
            onClick: (_entity, component) => {
                const actor = component.props.data.context;
                component.props.editor.switchEditor('model', {
                    rootState: {
                        entity: actor.props.entityIndex,
                        body: actor.props.bodyIndex,
                        anim: 0
                    }
                });
            },
            icon: () => 'editor/icons/body.svg'
        },
        {
            id: 'anim',
            name: 'Anim',
            value: (actor) => {
                if (actor.props.animIndex === -1) {
                    return '<no-anim>';
                }
                if (DebugData.metadata.anims[actor.props.animIndex]) {
                    return DebugData.metadata.anims[actor.props.animIndex];
                }
                return `anim_${actor.props.animIndex}`;
            },
            onClick: (_entity, component) => {
                const actor = component.props.data.context;
                component.props.editor.switchEditor('model', {
                    rootState: {
                        entity: actor.props.entityIndex,
                        body: 0,
                        anim: actor.props.animIndex
                    }
                });
            },
            icon: () => 'editor/icons/anim.svg'
        },
        {
            id: 'life',
            name: 'Life',
            value: actor => getComportement(actor),
            icon: () => 'editor/icons/script.png',
            render: (value) => {
                if (value === 'terminated') {
                    return <i>[OFF]</i>;
                }
                return <span>{mapComportementArg(value)}</span>;
            }
        },
        {
            id: 'move',
            name: 'Move',
            valueHash: (actor) => {
                const value = getMoveAction(actor);
                if (!value) {
                    return '[OFF]';
                }
                if (value.extra) {
                    return `${value.cmdName}_${value.extra}`;
                }
                return value.cmdName;
            },
            value: actor => getMoveAction(actor),
            icon: () => 'editor/icons/script.png',
            render: (value) => {
                if (!value)
                    return <i>[OFF]</i>;

                return <span>{value.cmdName}
                    {value.args
                        ? <span>(<i style={{color: '#ca0000'}}>{value.args}</i>)</span>
                        : ''}
                    {value.extra
                        ? <span style={{color: '#1a78c0'}}>
                            &nbsp;{value.extra}
                        </span>
                        : null}
                </span>;
            }
        }
    ],
    numChildren: actor => (actor.threeObject ? 1 : 0),
    child: () => SceneGraphNode,
    childData: actor => actor.threeObject,
    selected: (actor) => {
        const selection = DebugData.selection;
        return selection && selection.type === 'actor' && selection.index === actor.index;
    },
    onClick: (actor) => { DebugData.selection = {type: 'actor', index: actor.index}; },
    onDoubleClick: (actor) => {
        locateObject(actor);
    }
};

export const ActorsNode = makeObjectsNode('actor', {
    dynamic: true,
    needsData: true,
    name: () => 'Actors',
    icon: () => 'editor/icons/actor.svg',
    ctxMenu: [
        {
            name: 'Add new actor',
            onClick: component => createNewActor(component)
        }
    ],
    numChildren: scene => scene.actors.length,
    child: () => ActorNode,
    childData: (scene, idx) => scene.actors[idx],
    hasChanged: scene => scene.index !== DebugData.scope.scene,
    props: (_data, _ignored, component) => {
        const label = component.props.rootState.labels.actor;
        return [{
            id: 'visible',
            value: label,
            render: (visible) => {
                const style = {
                    width: 14,
                    height: 14,
                    cursor: 'pointer'
                };
                const onClick = () => {
                    component.props.rootStateHandler.setLabel('actor', !label);
                };
                return <img
                    style={style}
                    src={`editor/icons/${visible ? 'visible' : 'hidden'}_actors.svg`}
                    onClick={onClick}
                />;
            }
        }];
    }
});

function getComportement(actor: Actor) {
    const lifeScript = actor.scripts.life;
    if (lifeScript.context.state.terminated)
        return 'terminated';
    const info = DebugData.script.life[actor.index];
    if (info && 'section' in info) {
        return info.section;
    }
    return null;
}

function getMoveAction(actor) {
    const moveScript = actor.scripts.move;
    const offset = moveScript.context.state.lastOffset;
    if (offset) {
        const cmd = moveScript.commands[offset];
        const cmdName = cmd.op.command;
        if (cmdName !== 'STOP') {
            const args = map(cmd.args, arg => arg.value).join(', ');
            let key = `${cmdName}_${args}`;
            let extra;
            switch (cmdName) {
                case 'WAIT_NUM_SECOND':
                case 'WAIT_NUM_DSEC':
                case 'WAIT_NUM_SECOND_RND':
                case 'WAIT_NUM_DECIMAL_RND': {
                    const timeLeft = Math.ceil(
                        moveScript.context.state.waitUntil - DebugData.scope.game.clock.elapsedTime
                    );
                    extra = `[${timeLeft}″ left]`;
                    key += timeLeft;
                    break;
                }
                default:
                    break;
            }
            return {key, cmdName, args, extra};
        }
    }
    return null;
}

const icons = {};

function getEntityIcon(entity) {
    if (entity.index in icons) {
        return icons[entity.index];
    }
    const savedIcon = localStorage.getItem(`icon_model_entity_${entity.index}`);
    if (savedIcon) {
        icons[entity.index] = savedIcon;
        return savedIcon;
    }
    return 'editor/icons/entity.svg';
}

async function createNewActor(component) {
    const entity = await selectEntity(component);
    const body = await selectBody(component, entity);
    const anim = await selectAnim(component, entity);
    component.props.area.setState({ popup: null });
    component.props.rootStateHandler.setAddingObject('actor', {
        entityIndex: entity.index,
        bodyIndex: body.index,
        animIndex: anim.index
    });
}

const popupStyle = {
    height: '90%',
    overflowY: 'auto' as const
};

const itemStyle = {
    position: 'relative' as const,
    paddingLeft: '30px',
    cursor: 'pointer',
    lineHeight: '30px'
};

const iconStyle = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: 0,
    height: '20px',
    width: '20px',
    padding: 5,
    margin: 0
};

async function selectEntity(component): Promise<any> {
    await loadEntities();
    const entities = getEntities();
    return new Promise((resolve) => {
        component.props.area.confirmPopup(
            <div style={popupStyle}>
                <h2>Pick an entity:</h2>
                {map(entities, entity =>
                <div
                    key={entity.index}
                    style={itemStyle}
                    onClick={() => resolve(entity)}>
                    <img style={iconStyle} src={getEntityIcon(entity)} />
                    {DebugData.metadata.entities[entity.index] || `entity_${entity.index}`}
                </div>)}
            </div>,
            null,
            'Cancel'
        );
    });
}

async function selectBody(component, entity): Promise<any> {
    return new Promise((resolve) => {
        component.props.area.confirmPopup(
            <div style={popupStyle}>
                <h2>Pick a body:</h2>
                {map(entity.bodies, body =>
                <div
                    key={body.index}
                    style={itemStyle}
                    onClick={() => resolve(body)}>
                    <img style={iconStyle} src="editor/icons/body.svg" />
                    {DebugData.metadata.bodies[body.index] || `body_${body.index}`}
                </div>)}
            </div>,
            null,
            'Cancel'
        );
    });
}

async function selectAnim(component, entity): Promise<any> {
    return new Promise((resolve) => {
        component.props.area.confirmPopup(
            <div style={popupStyle}>
                <h2>Pick an anim:</h2>
                {map(entity.anims, anim =>
                <div
                    key={anim.index}
                    style={itemStyle}
                    onClick={() => resolve(anim)}>
                    <img style={iconStyle} src="editor/icons/anim.svg" />
                    {DebugData.metadata.anims[anim.index] || `anim_${anim.index}`}
                </div>)}
            </div>,
            null,
            'Cancel'
        );
    });
}
