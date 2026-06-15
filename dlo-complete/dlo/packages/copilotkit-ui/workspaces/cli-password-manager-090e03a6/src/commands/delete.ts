import click
import sqlite3
from pathlib import Path
from getpass import getpass
from typing import List, Optional, Dict, Any
from cryptography.fernet import Fernet
import json
from datetime import datetime

from ..core.password_manager import PasswordManager
from ..db.database import Database
from ..utils.security import validate_master_password, secure_input
from ..utils.logger import logger


@click.command('delete')
@click.argument('search_term', required=True)
@click.option('--force', '-f', is_flag=True, help='Skip confirmation prompt')
@click.option('--quiet', '-q', is_flag=True, help='Suppress output messages')
def delete(search_term: str, force: bool, quiet: bool) -> None:
    """Delete a password entry by name or service.
    
    Args:
        search_term: Service name or identifier to search for
        force: Skip confirmation prompts
        quiet: Suppress informational output
    """
    try:
        # Initialize database and password manager
        db = Database()
        pm = PasswordManager(db)
        
        # Verify master password before proceeding
        master_password = getpass('Enter master password: ', stream=None)
        
        if not validate_master_password(master_password, db):
            click.secho('Error: Invalid master password', fg='red', err=True)
            raise SystemExit(1)
        
        # Search for matching password entries
        matches: List[Dict[str, Any]] = db.search_passwords(search_term)
        
        if not matches:
            click.secho(f'No passwords found matching "{search_term}"', fg='yellow')
            return
        
        # Handle multiple matches
        if len(matches) > 1:
            selected_entry = _handle_multiple_matches(matches, force, quiet)
            if selected_entry is None:
                click.echo('Delete cancelled')
                return
        else:
            selected_entry = matches[0]
        
        # Confirm deletion unless forced
        if not force and not quiet:
            click.secho(
                f'Deleting: {selected_entry["service"]} ({selected_entry["username"]})',
                fg='yellow'
            )
            
            if not click.confirm('Are you sure you want to delete this entry?'):
                click.echo('Delete cancelled')
                return
        
        # Perform deletion
        success = db.delete_password(selected_entry['id'])
        
        if success:
            if not quiet:
                click.secho(
                    f'✓ Successfully deleted: {selected_entry["service"]}',
                    fg='green'
                )
        else:
            click.secho('Error: Failed to delete password entry', fg='red', err=True)
            raise SystemExit(1)
            
    except KeyboardInterrupt:
        click.secho('\n✗ Operation cancelled by user', fg='red')
        raise SystemExit(130)
    except Exception as e:
        click.secho(f'Error: {str(e)}', fg='red', err=True)
        logger.error(f'Delete command failed: {str(e)}')
        raise SystemExit(1)


def _handle_multiple_matches(
    matches: List[Dict[str, Any]],
    force: bool,
    quiet: bool
) -> Optional[Dict[str, Any]]:
    """Handle selection when multiple password entries match search term.
    
    Args:
        matches: List of matching password entries
        force: Skip confirmation if True
        quiet: Suppress output if True
        
    Returns:
        Selected entry or None if cancelled
    """
    if force:
        # In force mode, delete the first match
        return matches[0]
    
    if not quiet:
        click.echo(f'\nFound {len(matches)} matching entries:\n')
        for i, entry in enumerate(matches, 1):
            created = datetime.fromisoformat(entry['created_at']).strftime('%Y-%m-%d')
            click.echo(
                f'  {i}. {entry["service"]:<20} | {entry["username"]:<20} | {created}'
            )
        click.echo()
    
    # Prompt user to select which entry to delete
    try:
        selection = click.prompt(
            'Select entry number to delete',
            type=click.IntRange(1, len(matches)),
            err=False
        )
        return matches[selection - 1]
    except click.BadParameter:
        return None


if __name__ == '__main__':
    delete()