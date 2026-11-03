"""Shared, side-effect-free production inputs for reviewers and prompt agents."""


def expected_shot(project, shot):
    return {
        "title": shot.title,
        "scene": shot.scene,
        "action": shot.visual,
        "dialogue": shot.narration,
        "style": project.style,
        "characters": [c.model_dump() for c in project.characters if c.id in shot.characters],
    }
